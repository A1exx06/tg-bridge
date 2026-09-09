import { readFile } from 'fs/promises'

export interface StopHookInput {
  transcript_path?: string
  last_assistant_message?: unknown
}

export interface StopHookOutput {
  assistant_message: string
}

interface TextBlock { type: 'text'; text: string }
type ContentBlock = TextBlock | { type: string; [k: string]: unknown }

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return (content as ContentBlock[])
      .filter((b): b is TextBlock => b?.type === 'text' && typeof (b as TextBlock).text === 'string')
      .map(b => b.text)
      .join('\n')
  }
  return ''
}

function isUserPrompt(content: unknown): boolean {
  if (typeof content === 'string') return content.length > 0
  if (Array.isArray(content)) {
    return (content as ContentBlock[]).some(b => b?.type !== 'tool_result')
  }
  return false
}

export async function handleStopHook(input: StopHookInput): Promise<StopHookOutput> {
  const direct = extractText(input.last_assistant_message)
  if (direct.length > 0) return { assistant_message: direct }
  if (!input.transcript_path) return { assistant_message: '' }
  const raw = await readFile(input.transcript_path, 'utf8').catch(() => '')
  if (raw.length === 0) return { assistant_message: '' }
  const lines = raw.trim().split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line) continue
    try {
      const parsed = JSON.parse(line) as {
        type?: string
        content?: unknown
        message?: { role?: string; content?: unknown }
      }
      if (parsed.type === 'assistant') {
        const text = extractText(parsed.message?.content ?? parsed.content)
        if (text.length > 0) return { assistant_message: text }
      }
      // Turn boundary: a real user prompt (not a tool_result envelope) means
      // the current turn produced no text at all (e.g. it ended on a deferred
      // tool such as ScheduleWakeup). Never walk into the previous turn —
      // that re-sent the previous reply verbatim (duplicates, 10.09.2026).
      if (parsed.type === 'user' && isUserPrompt(parsed.message?.content ?? parsed.content)) {
        return { assistant_message: '' }
      }
    } catch { /* skip malformed */ }
  }
  return { assistant_message: '' }
}
