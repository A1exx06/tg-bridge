import type { ParsedFile } from './parser.js'

export type FileRoute =
  | { action: 'send'; chat: number }
  | { action: 'drop'; reason: string }

/**
 * Decide which chat a parsed file should be sent to.
 *
 * - No `chat=` attribute → send to the last-inbound chat (current behaviour).
 * - `chat=` set and in the proactive whitelist → send to that chat.
 * - `chat=` set but whitelist empty or chat not whitelisted → drop. We refuse
 *   to send to an arbitrary chat the model named: a proactive misfire could
 *   leak content into a wrong conversation, which is worse than a missing file.
 */
export function routeFile(
  file: ParsedFile,
  lastInbound: number | undefined,
  whitelist: number[],
): FileRoute {
  if (file.chat === undefined) {
    if (lastInbound === undefined) return { action: 'drop', reason: 'no-last-inbound' }
    return { action: 'send', chat: lastInbound }
  }
  if (whitelist.length === 0) {
    return { action: 'drop', reason: 'proactive-disabled' }
  }
  if (!whitelist.includes(file.chat)) {
    return { action: 'drop', reason: 'chat-not-whitelisted' }
  }
  return { action: 'send', chat: file.chat }
}
