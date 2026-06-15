import { Bot, InputFile } from 'grammy'
import type { ReactionTypeEmoji } from '@grammyjs/types'
import { chunkForTelegram } from '../reply/sender.js'
import { createSendGovernor } from './send-governor.js'
import type { Logger } from '../log.js'
import { extname } from 'path'

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

export function createBot(token: string, log: Logger): BotWrapper {
  const bot = new Bot(token)

  // Per-chat outbound governor: paces sends (~1/sec/chat) and honors 429
  // retry_after so a chatty agent can't trip Telegram flood-control or hammer
  // the API. Wraps every send/edit; non-chat methods pass through.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  bot.api.config.use(createSendGovernor(log) as any)

  return {
    raw: bot,
    async sendText(chatId, text, replyToMessageId) {
      for (const chunk of chunkForTelegram(text)) {
        await bot.api.sendMessage(
          chatId,
          chunk,
          replyToMessageId
            ? { reply_parameters: { message_id: replyToMessageId } }
            : {},
        ).catch(err => log.warn('sendMessage failed', { error: String(err) }))
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
      const file = new InputFile(spec.path)
      const opts = spec.caption ? { caption: spec.caption } : {}
      try {
        if (kind === 'photo') await bot.api.sendPhoto(chatId, file, opts)
        else if (kind === 'video') await bot.api.sendVideo(chatId, file, opts)
        else if (kind === 'voice') await bot.api.sendVoice(chatId, file, opts)
        else await bot.api.sendDocument(chatId, file, opts)
      } catch (err) {
        log.warn('sendFile failed', { error: String(err), kind, path: spec.path })
      }
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
