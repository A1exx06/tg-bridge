import type { ToolInvocation } from './policy.js'

export interface RelayOpts {
  sendPrompt: (chatId: number, text: string, reqId: string) => Promise<void>
  ownerChatId: number
  timeoutMs: number
  defaultDecision: 'allow' | 'deny'
}

type Decision = 'allow' | 'deny'

export interface Relay {
  requestVerdict(inv: ToolInvocation): Promise<Decision>
  callbackAnswer(reqId: string, decision: Decision): void
  // Text-reply path: the owner can't always tap inline buttons (they don't
  // render on some clients), so a plain "да"/"нет" message resolves the most
  // recent pending request. pendingCount lets the message handler decide whether
  // a yes/no message is an answer to a permission prompt vs. a normal prompt.
  pendingCount(): number
  answerLatest(decision: Decision): boolean
}

export function createRelay(opts: RelayOpts): Relay {
  const pending = new Map<string, { resolve: (d: Decision) => void; timer: ReturnType<typeof setTimeout> }>()

  return {
    requestVerdict(inv) {
      const reqId = crypto.randomUUID()
      return new Promise<Decision>(resolve => {
        const timer = setTimeout(() => {
          pending.delete(reqId)
          resolve(opts.defaultDecision)
        }, opts.timeoutMs)
        pending.set(reqId, { resolve, timer })
        const cmd = typeof inv.args['command'] === 'string' ? (inv.args['command'] as string) : '<no command>'
        const prompt = `Agent wants to run:\n${inv.tool}: ${cmd}\n\nAllow or Deny? (можно ответить текстом: «да» / «нет»)`
        void opts.sendPrompt(opts.ownerChatId, prompt, reqId).catch(() => {})
      })
    },
    callbackAnswer(reqId, decision) {
      const p = pending.get(reqId)
      if (!p) return
      clearTimeout(p.timer)
      pending.delete(reqId)
      p.resolve(decision)
    },
    pendingCount() {
      return pending.size
    },
    answerLatest(decision) {
      // Map preserves insertion order, so the last key is the newest request.
      let lastKey: string | undefined
      for (const k of pending.keys()) lastKey = k
      if (lastKey === undefined) return false
      const p = pending.get(lastKey)
      if (!p) return false
      clearTimeout(p.timer)
      pending.delete(lastKey)
      p.resolve(decision)
      return true
    },
  }
}
