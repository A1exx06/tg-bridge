import { Bot, InputFile } from 'grammy'
import type { ReactionTypeEmoji } from '@grammyjs/types'
import { chunkForTelegram } from '../reply/sender.js'
import { createSendGovernor } from './send-governor.js'
import type { Logger } from '../log.js'
import { extname, join } from 'path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { appendFileSync, mkdirSync, statSync, unlinkSync } from 'fs'
import { createHash } from 'node:crypto'

const execFileP = promisify(execFile)

const PHOTO_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp'])
const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm'])
const VOICE_EXT = new Set(['.ogg', '.oga', '.opus'])

export interface FileSpec {
  path: string
  caption?: string
  kind?: 'photo' | 'video' | 'document' | 'voice'
}

function inferKind(spec: FileSpec): 'photo' | 'video' | 'document' | 'voice' {
  if (spec.kind) return spec.kind
  const ext = extname(spec.path).toLowerCase()
  if (PHOTO_EXT.has(ext)) return 'photo'
  if (VIDEO_EXT.has(ext)) return 'video'
  if (VOICE_EXT.has(ext)) return 'voice'
  return 'document'
}

export interface BotButton {
  label: string
  payload: string
}

const POSITIVE_RE = /^(ha|yes|da|да|ок|ага|конечно|давай|принято|подтверждаю|ok|tasdiq|aha|albatta|sure|yep|qabul)$/i
const NEGATIVE_RE = /^(yo'?q|yoq|no|net|нет|не|отмена|отклонить|bekor|cancel|reject|rad)$/i

function decorateLabel(label: string): string {
  const s = label.trim()
  if (/^\p{Emoji}/u.test(s)) return s
  if (POSITIVE_RE.test(s)) return `✅ ${s}`
  if (NEGATIVE_RE.test(s)) return `❌ ${s}`
  return s
}

export interface BotWrapper {
  raw: Bot
  sendText(chatId: number, text: string, replyToMessageId?: number): Promise<void>
  sendRich(chatId: number, markdown: string): Promise<boolean>
  sendButtons(chatId: number, text: string, buttons: BotButton[]): Promise<void>
  clearButtons(chatId: number, messageId: number): Promise<void>
  sendHtml(chatId: number, html: string): Promise<number | null>
  editHtml(chatId: number, messageId: number, html: string): Promise<void>
  deleteMessage(chatId: number, messageId: number): Promise<void>
  setReaction(chatId: number, messageId: number, emoji: string): Promise<void>
  sendFile(chatId: number, spec: FileSpec): Promise<void>
  sendChatAction(chatId: number, action: 'typing' | 'upload_photo' | 'upload_document'): Promise<void>
  getMe(): Promise<{ id: number; username: string }>
  start(onUpdate: (update: unknown) => Promise<void>): Promise<void>
  stop(): Promise<void>
}

const EMOJI_MAP: Record<string, string> = {
  thumbsup: '👍', thumbsdown: '👎', heart: '❤', fire: '🔥',
  eyes: '👀', hundred: '💯', clap: '👏', pray: '🙏',
  ok: '👌', check: '✅', cross: '❌', warning: '⚠️',
}

// A half-open TCP connection to Telegram leaves fetch waiting forever: no
// data, no error, so no retry logic ever runs and the bridge stays "active"
// but deaf (incident 2026-08-13, FIX-POLL-WATCHDOG-2026-08-13.md). A hard
// abort turns that hang into an error grammY's polling loop retries normally.
// Budget must exceed the long-poll `timeout` (30s server-side) with slack;
// multipart uploads (sendVideo of tens of MB on a throttled link) legitimately
// run much longer, so non-string bodies get a wider budget.
const API_CALL_TIMEOUT_MS = 75_000
const UPLOAD_TIMEOUT_MS = 600_000

// Cast: bun's `typeof fetch` also carries a `preconnect` helper that a plain
// wrapper function lacks; grammY only ever calls the function itself.
const timedFetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const isJsonCall = init?.body === undefined || typeof init.body === 'string'
  const timeout = AbortSignal.timeout(isJsonCall ? API_CALL_TIMEOUT_MS : UPLOAD_TIMEOUT_MS)
  const signal = init?.signal
    ? AbortSignal.any([init.signal as AbortSignal, timeout])
    : timeout
  return fetch(input, { ...init, signal })
}) as typeof fetch

// ── M4-lite reliable outbound (ported from dashi-plugin M4, 2026-08-13) ──
// A failed send is only safely retryable when Telegram provably never saw it:
// connection-phase failures (refused / DNS). Anything else — reset, abort,
// 5xx — MAY have landed, and retrying a sendMessage there risks duplicates.
// Policy: retry pre_send up to 2 times (1s/5s), everything else fails once,
// loudly; every terminal failure is appended to a dead-letter JSONL so a lost
// reply is a record, not a silent hole (the 2026-08-13 outage failure mode).
const PRE_SEND_PATTERNS = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ConnectionRefused|Unable to connect/i
const RETRY_DELAYS_MS = [1_000, 5_000]

// Bot API hard limit is 50MB; leave headroom for multipart overhead.
const MAX_UPLOAD_BYTES = 48 * 1024 * 1024

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// Video metadata for outbound sends. Best-effort: a missing ffprobe/ffmpeg or
// an odd container degrades to the old metadata-less send, never to a failure.
async function probeVideo(
  path: string,
  log: Logger,
): Promise<{ duration?: number; width?: number; height?: number; thumbPath?: string }> {
  try {
    const { stdout } = await execFileP('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height:format=duration',
      '-of', 'json',
      path,
    ])
    const parsed = JSON.parse(stdout) as {
      streams?: Array<{ width?: number; height?: number }>
      format?: { duration?: string }
    }
    const width = parsed.streams?.[0]?.width
    const height = parsed.streams?.[0]?.height
    const durationRaw = Number(parsed.format?.duration)
    const duration = Number.isFinite(durationRaw) && durationRaw > 0 ? Math.round(durationRaw) : undefined
    let thumbPath: string | undefined = join(tmpdir(), `tg-thumb-${process.pid}-${Date.now()}.jpg`)
    try {
      // -ss after the start for a non-black frame; ≤320px per Bot API limits.
      const seek = duration !== undefined && duration < 2 ? '0' : '1'
      await execFileP('ffmpeg', ['-y', '-ss', seek, '-i', path, '-frames:v', '1', '-vf', 'scale=320:-2', thumbPath])
    } catch {
      thumbPath = undefined
    }
    const out: { duration?: number; width?: number; height?: number; thumbPath?: string } = {}
    if (duration !== undefined) out.duration = duration
    if (width !== undefined) out.width = width
    if (height !== undefined) out.height = height
    if (thumbPath !== undefined) out.thumbPath = thumbPath
    return out
  } catch (err) {
    log.warn('video probe failed, sending without metadata', { error: String(err) })
    return {}
  }
}

export function createBot(
  token: string,
  log: Logger,
  opts?: { deadLetterDir?: string },
): BotWrapper {
  const bot = new Bot(token, { client: { fetch: timedFetch } })

  const deadLetter = (method: string, chatId: number | string, payloadDesc: string, error: string): void => {
    if (!opts?.deadLetterDir) return
    try {
      mkdirSync(opts.deadLetterDir, { recursive: true })
      appendFileSync(
        join(opts.deadLetterDir, 'outbound-dead-letter.jsonl'),
        JSON.stringify({
          ts: new Date().toISOString(),
          method,
          chat_id: chatId,
          // Hash, not payload: dead-letter must never become a secrets sink.
          payload_sha256: createHash('sha256').update(payloadDesc).digest('hex'),
          error,
        }) + '\n',
      )
    } catch (dlErr) {
      log.warn('dead-letter write failed', { error: String(dlErr) })
    }
  }

  const sendReliably = async (
    method: string,
    chatId: number | string,
    payloadDesc: string,
    fn: () => Promise<unknown>,
  ): Promise<boolean> => {
    for (let attempt = 0; ; attempt++) {
      try {
        await fn()
        return true
      } catch (err) {
        const msg = String(err)
        const preSend = PRE_SEND_PATTERNS.test(msg)
        if (preSend && attempt < RETRY_DELAYS_MS.length) {
          log.warn(`${method} pre-send failure, retrying`, { attempt: attempt + 1, error: msg })
          await sleepMs(RETRY_DELAYS_MS[attempt] ?? 5_000)
          continue
        }
        log.error(`${method} failed${preSend ? ' after retries' : ''} — dead-lettered`, { error: msg })
        deadLetter(method, chatId, payloadDesc, msg)
        return false
      }
    }
  }

  // Per-chat outbound governor: paces sends (~1/sec/chat) and honors 429
  // retry_after so a chatty agent can't trip Telegram flood-control or hammer
  // the API. Wraps every send/edit; non-chat methods pass through.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  bot.api.config.use(createSendGovernor(log) as any)

  return {
    raw: bot,
    async sendText(chatId, text, replyToMessageId) {
      for (const chunk of chunkForTelegram(text)) {
        await sendReliably('sendMessage', chatId, chunk, () =>
          bot.api.sendMessage(
            chatId,
            chunk,
            replyToMessageId
              ? { reply_parameters: { message_id: replyToMessageId } }
              : {},
          ))
      }
    },
    // Rich message (Bot API, added 2026-06-11): sends the agent's raw markdown
    // via sendRichMessage so headings/tables/lists/quotes render natively, up to
    // 32768 chars (no 4000-char chunking, no HTML downgrade). Direct fetch because
    // grammY's typed RawApi may not yet expose the method. Returns false on any
    // failure so the caller can fall back to the proven parse_mode='HTML' path.
    async sendRich(chatId, markdown) {
      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendRichMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, rich_message: { markdown } }),
          // Direct fetch bypasses grammY's client, so it needs its own abort:
          // during the 2026-08-13 outage this exact call sat on a dead backend.
          signal: AbortSignal.timeout(API_CALL_TIMEOUT_MS),
        })
        const body = await res.json().catch(() => ({})) as { ok?: boolean; description?: string }
        if (res.ok && body.ok) return true
        log.warn('sendRich not delivered, falling back', { status: res.status, desc: body.description })
        return false
      } catch (err) {
        log.warn('sendRich failed, falling back', { error: String(err) })
        return false
      }
    },
    async sendButtons(chatId, text, buttons) {
      if (buttons.length === 0) return
      const rows = buttons.map((b) => [{ text: decorateLabel(b.label), callback_data: `abtn:${b.payload}` }])
      try {
        await bot.api.sendMessage(chatId, text, {
          reply_markup: { inline_keyboard: rows },
        })
      } catch (err) {
        log.warn('sendButtons failed', { error: String(err) })
      }
    },
    async clearButtons(chatId, messageId) {
      try {
        await bot.api.editMessageReplyMarkup(chatId, messageId, { reply_markup: { inline_keyboard: [] } })
      } catch (err) {
        const msg = String(err)
        if (!msg.includes('message is not modified')) {
          log.warn('clearButtons failed', { error: msg })
        }
      }
    },
    async sendHtml(chatId, html) {
      try {
        const m = await bot.api.sendMessage(chatId, html, { parse_mode: 'HTML' })
        return m.message_id
      } catch (err) {
        log.warn('sendHtml failed', { error: String(err) })
        return null
      }
    },
    async editHtml(chatId, messageId, html) {
      try {
        await bot.api.editMessageText(chatId, messageId, html, { parse_mode: 'HTML' })
      } catch (err) {
        const msg = String(err)
        if (!msg.includes('message is not modified')) {
          log.warn('editHtml failed', { error: msg })
        }
      }
    },
    async deleteMessage(chatId, messageId) {
      try {
        await bot.api.deleteMessage(chatId, messageId)
      } catch (err) {
        log.warn('deleteMessage failed', { error: String(err) })
      }
    },
    async sendChatAction(chatId, action) {
      try {
        await bot.api.sendChatAction(chatId, action)
      } catch {
        // best-effort; ignored
      }
    },
    async sendFile(chatId, spec) {
      const kind = inferKind(spec)
      // Bot API caps uploads at 50MB. A doomed oversized multipart still pumps
      // the full file into api.telegram.org before the 413 lands; a run of
      // those degraded this bot's gateway shard into all-504 twice (13.08 and
      // 19.08 incidents). Never start an upload that cannot succeed.
      const sizeBytes = statSync(spec.path).size
      if (sizeBytes > MAX_UPLOAD_BYTES) {
        const sizeMb = Math.round(sizeBytes / 1048576)
        log.error('sendFile refused: over Bot API 50MB limit', { path: spec.path, size_mb: sizeMb })
        deadLetter('sendFile', chatId, spec.path, `refused pre-flight: ${sizeMb}MB > 50MB Bot API limit`)
        await bot.api.sendMessage(
          chatId,
          `Файл не отправлен: ${sizeMb}MB превышает лимит Telegram для ботов (50MB).\n${spec.path}`,
        ).catch(() => { /* best-effort notice */ })
        return
      }
      const file = new InputFile(spec.path)
      const opts = spec.caption ? { caption: spec.caption } : {}
      if (kind === 'video') {
        // Without explicit metadata Telegram probes the mp4 itself and for
        // some encodes yields a broken 0:00 card — unplayable and not savable
        // to the gallery (root-fix for the long-standing [FILE:] video bug;
        // the manual Bot API recipe proved metadata fixes it, 2026-07-12).
        const meta = await probeVideo(spec.path, log)
        const videoOpts: Parameters<typeof bot.api.sendVideo>[2] = {
          ...opts,
          supports_streaming: true,
          ...(meta.duration !== undefined ? { duration: meta.duration } : {}),
          ...(meta.width !== undefined ? { width: meta.width } : {}),
          ...(meta.height !== undefined ? { height: meta.height } : {}),
          ...(meta.thumbPath ? { thumbnail: new InputFile(meta.thumbPath) } : {}),
        }
        await sendReliably('sendVideo', chatId, spec.path, () =>
          bot.api.sendVideo(chatId, file, videoOpts))
        if (meta.thumbPath) {
          try { unlinkSync(meta.thumbPath) } catch { /* tmp cleanup, best-effort */ }
        }
        return
      }
      const methodName = `send${kind.charAt(0).toUpperCase()}${kind.slice(1)}`
      await sendReliably(methodName, chatId, spec.path, () => {
        if (kind === 'photo') return bot.api.sendPhoto(chatId, file, opts)
        if (kind === 'voice') return bot.api.sendVoice(chatId, file, opts)
        return bot.api.sendDocument(chatId, file, opts)
      })
    },
    async setReaction(chatId, messageId, emojiSlug) {
      const emoji = EMOJI_MAP[emojiSlug]
      if (!emoji) {
        log.warn('unknown reaction slug', { slug: emojiSlug })
        return
      }
      await bot.api.setMessageReaction(
        chatId,
        messageId,
        [{ type: 'emoji', emoji: emoji as ReactionTypeEmoji['emoji'] }],
      ).catch(err => log.warn('setReaction failed', { error: String(err) }))
    },
    async getMe() {
      const me = await bot.api.getMe()
      return { id: me.id, username: me.username }
    },
    async start(onUpdate) {
      bot.use(async (ctx) => { await onUpdate(ctx.update) })
      bot.catch((err) => {
        const msg = String(err?.error ?? err)
        if (msg.includes('409') || /conflict/i.test(msg)) {
          log.warn('telegram polling conflict (another instance polling); grammY will retry', { error: msg })
        } else {
          log.warn('bot error', { error: msg })
        }
      })
      void bot.start({ allowed_updates: ['message', 'callback_query', 'business_message', 'business_connection'] })
    },
    async stop() {
      await bot.stop()
    },
  }
}
