// Per-chat outbound governor for the Telegram API.
//
// Why: the bridge emits one message per agent turn (plus a transient mirror).
// A chatty / long autonomous run fires many sends back-to-back; Telegram then
// flood-controls the chat (HTTP 429) and the bridge keeps hammering the API —
// the operator sees a burst then silence, and at scale the raw retry pressure
// is a cheap DoS lever. This transformer makes that physically impossible
// regardless of how talkative the agent is:
//
//   1. Serializes API calls per chat behind a minimum inter-send gap, so bursts
//      drain at a safe pace (~1 msg/sec/chat, Telegram's own limit) instead of
//      all at once.
//   2. Honors 429 `retry_after`: on flood-control it waits exactly as long as
//      Telegram asks (bounded retries) instead of re-firing immediately.
//
// Implemented as a grammY API transformer so it wraps EVERY send/edit uniformly.
// Non-chat methods (getMe, getUpdates, …) pass straight through.

import type { Logger } from '../log.js'

export interface GovernorOpts {
  minGapMs?: number
  max429Retries?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

// grammY transformer signature (kept structural to avoid a hard type dep here).
type RawResult = { ok: boolean; error_code?: number; parameters?: { retry_after?: number } }
type Transformer = (
  prev: (method: string, payload: Record<string, unknown>, signal?: AbortSignal) => Promise<RawResult>,
  method: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<RawResult>

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function createSendGovernor(log: Logger, opts: GovernorOpts = {}): Transformer {
  const minGapMs = opts.minGapMs ?? Number(process.env.TG_SEND_MIN_GAP_MS ?? 1100)
  const max429 = opts.max429Retries ?? 3
  const sleep = opts.sleep ?? defaultSleep
  const now = opts.now ?? Date.now

  // Per-chat: a promise chain that serializes calls, and the last-send timestamp.
  const chain = new Map<string, Promise<unknown>>()
  const lastAt = new Map<string, number>()

  return async (prev, method, payload, signal) => {
    const chatId = payload?.chat_id
    if (chatId === undefined || chatId === null) {
      // Not chat-scoped (getMe / getUpdates / answerCallbackQuery without chat) — no throttle.
      return prev(method, payload, signal)
    }
    const key = String(chatId)

    const run = async (): Promise<RawResult> => {
      // First-ever send to this chat does not wait; subsequent ones honor the gap.
      const last = lastAt.get(key)
      const gap = last === undefined ? 0 : minGapMs - (now() - last)
      if (gap > 0) await sleep(gap)

      let attempt = 0
      for (;;) {
        lastAt.set(key, now())
        const res = await prev(method, payload, signal)
        if (res.ok || res.error_code !== 429 || attempt >= max429) return res
        attempt += 1
        const retryAfter = res.parameters?.retry_after ?? 1
        log.warn('telegram 429 — honoring retry_after', { method, chat: key, retry_after: retryAfter, attempt })
        await sleep(retryAfter * 1000 + 250)
      }
    }

    const previous = chain.get(key) ?? Promise.resolve()
    // Run after the previous call for this chat settles (success OR failure), so a
    // single throwing call can't wedge the chain.
    const next = previous.then(run, run)
    chain.set(key, next.then(() => undefined, () => undefined))
    return next
  }
}
