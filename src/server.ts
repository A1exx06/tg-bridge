import { loadConfig } from './config.js'
import { createLogger } from './log.js'
import { createFsm, ClaudeState } from './claude/state.js'
import { createQueue } from './claude/queue.js'
import { createTmuxSession } from './claude/tmux-session.js'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { loadOrCreateSid, buildClaudeCommand, latestTranscriptSid } from './claude/session-id.js'
import { createBot } from './telegram/bot.js'
import { allowMessage } from './telegram/gate.js'
import { injectSenderPrefix } from './persona/sender-prefix.js'
import { parseReply } from './reply/parser.js'
import { routeFile } from './reply/file-route.js'
import { formatReplyHtml } from './reply/markdown.js'
import { redactOutbound } from './reply/redact-outbound.js'
import { startHttpServer } from './hooks/http-server.js'
import { handleStopHook } from './hooks/stop.js'
import { ProgressTracker } from './progress/tracker.js'
import { transcribeAudio, loadGroqKey } from './voice/groq.js'
import { downloadTelegramFile } from './telegram/file.js'
import { cleanupUploads } from './uploads/cleanup.js'
import { getSql, closeSql, loadDsn, type Sql } from './db/pool.js'
import { insertChatLog } from './db/chat_log.js'
import { upsertAgentState } from './db/agent_state.js'
import { writeFileSync } from 'fs'
import { basename } from 'path'
import { createRelay } from './permission/relay.js'
import { needsRelay, type Policy } from './permission/policy.js'
import { mkdirSync, existsSync, readFileSync } from 'fs'
import { load as loadYaml } from 'js-yaml'
import { join, dirname } from 'path'

const cfg = loadConfig(process.env)

mkdirSync(cfg.paths.state_dir, { recursive: true })
mkdirSync(cfg.paths.log_dir, { recursive: true })

const log = createLogger({
  secrets: [cfg.telegram.bot_token, cfg.bridge.bearer_token],
})

log.info('starting', { agent: cfg.claude.tmux_session, port: cfg.bridge.port })

const dsn = cfg.db.dsn_file ? loadDsn(cfg.db.dsn_file) : null
const sql: Sql | null = dsn ? getSql({ dsn, agent: cfg.db.agent_name, logger: log }) : null
if (sql) log.info('db enabled', { agent: cfg.db.agent_name })
else log.info('db disabled', { reason: cfg.db.dsn_file ? 'dsn-missing' : 'no-dsn-file' })

const dbInsertIn = async (channel: QueueChannel, text: string, meta: Record<string, unknown>): Promise<void> => {
  if (!sql) return
  await insertChatLog(sql, log, { agent: cfg.db.agent_name, channel, direction: 'in', text, meta })
}
const dbInsertOut = async (channel: QueueChannel, text: string, meta: Record<string, unknown>): Promise<void> => {
  if (!sql) return
  await insertChatLog(sql, log, { agent: cfg.db.agent_name, channel, direction: 'out', text, meta })
}
const dbSetWorking = async (task: string | null): Promise<void> => {
  if (!sql) return
  await upsertAgentState(sql, log, { agent: cfg.db.agent_name, status: 'working', currentTask: task ?? null })
}
const dbSetIdle = async (): Promise<void> => {
  if (!sql) return
  await upsertAgentState(sql, log, { agent: cfg.db.agent_name, status: 'idle', currentTask: null, progressHtml: null })
}

const policyPath = join(cfg.paths.state_dir, '..', 'permission-policy.yaml')
let policy: Policy = { relay_patterns: [], default: 'allow' }
if (existsSync(policyPath)) {
  policy = loadYaml(readFileSync(policyPath, 'utf8')) as Policy
}

const fsm = createFsm()

type QueueChannel = 'telegram' | 'web' | 'swarm'
interface QueueItem {
  chat_id: number
  user_id: number
  text: string
  message_id: number
  channel: QueueChannel
  web_session_id?: string
}
const queue = createQueue<QueueItem>({
  maxDepth: cfg.limits.queue_max_depth,
})

// Stable session id persisted on disk → resume the same conversation across
// reboot / hardRestart instead of starting fresh (gateway.py's durable-resume).
// On first run (no sid file yet) adopt the workspace's most recent transcript
// so the conversation that is already live survives the first respawn too.
const claudeHome = process.env.HOME ?? homedir()
const claudeSid = loadOrCreateSid(
  cfg.paths.state_dir,
  () => latestTranscriptSid(claudeHome, cfg.claude.workspace) ?? randomUUID(),
)
log.info('claude session id', { sid: claudeSid })
const tmux = createTmuxSession({
  socket: cfg.claude.tmux_socket,
  session: cfg.claude.tmux_session,
  cwd: cfg.claude.workspace,
  secretDir: cfg.paths.state_dir,
  // Inbox-channel opt-in (INPUT_CHANNEL=inbox). Unset → legacy send-keys.
  inboxDir:
    cfg.claude.input_channel === 'inbox'
      ? join(cfg.paths.state_dir, 'inbox')
      : undefined,
  buildCommand: () =>
    buildClaudeCommand({
      binary: cfg.claude.binary,
      flags: cfg.claude.flags,
      workspace: cfg.claude.workspace,
      sid: claudeSid,
      home: claudeHome,
    }),
})

await tmux.ensure()
log.info('tmux session ready')

const bot = createBot(cfg.telegram.bot_token, log, { deadLetterDir: cfg.paths.log_dir })

interface InboundOrigin {
  message_id: number
  channel: QueueChannel
  web_session_id?: string
}
const lastInbound = new Map<number, InboundOrigin>()

interface ActiveTurn {
  chatId: number
  channel: QueueChannel
  webSessionId?: string
  tracker: ProgressTracker
  progressMsgId: number | null
  pendingEdit: boolean
  lastEditMs: number
  tickHandle: ReturnType<typeof setInterval> | null
}
let active: ActiveTurn | null = null

const EDIT_MIN_GAP_MS = 1200
const TICK_INTERVAL_MS = 5000

const scheduleEdit = (turn: ActiveTurn): void => {
  if (turn.progressMsgId == null || turn.pendingEdit) return
  turn.pendingEdit = true
  const since = Date.now() - turn.lastEditMs
  const wait = Math.max(0, EDIT_MIN_GAP_MS - since)
  setTimeout(async () => {
    turn.pendingEdit = false
    turn.lastEditMs = Date.now()
    if (turn.progressMsgId == null) return
    await bot.editHtml(turn.chatId, turn.progressMsgId, turn.tracker.render())
  }, wait)
}

const startTurn = async (chatId: number, channel: QueueChannel = 'telegram', webSessionId?: string): Promise<void> => {
  if (cfg.streaming.mode === 'off') return
  const tracker = new ProgressTracker()
  const turn: ActiveTurn = {
    chatId,
    channel,
    tracker,
    progressMsgId: null,
    pendingEdit: false,
    lastEditMs: 0,
    tickHandle: null,
  }
  if (webSessionId) turn.webSessionId = webSessionId
  active = turn
  const id = await bot.sendHtml(chatId, tracker.render())
  turn.progressMsgId = id
  turn.lastEditMs = Date.now()
  turn.tickHandle = setInterval(() => scheduleEdit(turn), TICK_INTERVAL_MS)
}

const endTurn = async (finalState: 'done' = 'done'): Promise<void> => {
  if (!active) return
  const turn = active
  active = null
  if (turn.tickHandle) clearInterval(turn.tickHandle)
  if (turn.progressMsgId != null) {
    await bot.editHtml(turn.chatId, turn.progressMsgId, turn.tracker.render(finalState))
  }
}

const endTurnAndDelete = async (): Promise<void> => {
  if (!active) return
  const turn = active
  active = null
  if (turn.tickHandle) clearInterval(turn.tickHandle)
  if (turn.progressMsgId != null) {
    await bot.deleteMessage(turn.chatId, turn.progressMsgId)
  }
}

let busyTimer: ReturnType<typeof setTimeout> | null = null
// Message sent into the tmux pane but not yet acknowledged by any Claude
// activity (pretool / stop). If the busy timeout fires while this is still
// set, the send-keys never started a turn (TUI was busy/wedged on the
// previous turn) and the message was swallowed — so we re-queue it instead of
// dropping it. Cleared on the first real activity of the turn.
let inflight: QueueItem | null = null
let paneWatcher: ReturnType<typeof setInterval> | null = null
let typingPulse: ReturnType<typeof setInterval> | null = null
let typingChat: number | null = null
let lastPaneFingerprint = ''

// Tools where Claude pauses for human input (AskUserQuestion modal, plan-mode
// approval). While one is pending, no hook fires and the tmux pane only shows
// the modal — so the busy timer would force-IDLE while Claude is genuinely
// alive and waiting for the operator. We freeze the heartbeat for these.
const AWAITING_USER_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])
let awaitingUserTool: string | null = null
// The option-question message surfaced to Telegram for the active modal. The
// question already shows in the mirror, so once it's answered we delete this
// (and the operator's typed answer) — keeping the chat to the mirror + the real
// conversation. Scoped to this modal only; nothing else is removed.
let awaitingModal: { chat: number; msgId: number } | null = null

const clearAwaitingModal = (alsoDelete: boolean): void => {
  if (awaitingModal && alsoDelete) {
    void bot.deleteMessage(awaitingModal.chat, awaitingModal.msgId).catch(() => {})
  }
  awaitingModal = null
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function renderAwaitingUserPrompt(tool: string, args: Record<string, unknown>): string | null {
  if (tool === 'AskUserQuestion') {
    const questions = Array.isArray((args as { questions?: unknown }).questions)
      ? (args as { questions: Array<Record<string, unknown>> }).questions
      : []
    if (questions.length === 0) return null
    const lines: string[] = ['<b>❓ Агент задал вопрос:</b>', '']
    for (const q of questions) {
      const qText = typeof q.question === 'string' ? q.question : ''
      if (qText) lines.push(escapeHtml(qText))
      const opts = Array.isArray(q.options) ? q.options as Array<Record<string, unknown>> : []
      for (let i = 0; i < opts.length; i++) {
        const o = opts[i]!
        const label = typeof o.label === 'string' ? o.label : `option ${i + 1}`
        const desc = typeof o.description === 'string' ? ` — ${o.description}` : ''
        lines.push(`  ${i + 1}. <b>${escapeHtml(label)}</b>${escapeHtml(desc)}`)
      }
      lines.push('')
    }
    lines.push('<i>Напишите ответ обычным текстом в этот чат — он будет передан агенту.</i>')
    return lines.join('\n')
  }
  if (tool === 'ExitPlanMode') {
    const plan = typeof (args as { plan?: unknown }).plan === 'string'
      ? (args as { plan: string }).plan
      : ''
    const head = '<b>📋 Агент просит подтвердить план:</b>\n\n'
    const body = plan ? `<pre>${escapeHtml(plan)}</pre>\n\n` : ''
    return head + body + '<i>Подтвердить: напишите «да», либо пришлите нужные правки.</i>'
  }
  return null
}

const TYPING_TICK_MS = 4000

const startTyping = (chatId: number): void => {
  typingChat = chatId
  void bot.sendChatAction(chatId, 'typing')
  if (typingPulse) clearInterval(typingPulse)
  typingPulse = setInterval(() => {
    if (typingChat !== null) void bot.sendChatAction(typingChat, 'typing')
  }, TYPING_TICK_MS)
}

const stopTyping = (): void => {
  if (typingPulse) { clearInterval(typingPulse); typingPulse = null }
  typingChat = null
}

const PANE_TICK_MS = 30000

const paneFingerprint = (s: string): string => {
  const lines = s.replace(/[ \t]+$/gm, '').split('\n')
  return lines.slice(-60).join('\n')
}

const armBusyTimer = (): void => {
  if (busyTimer) clearTimeout(busyTimer)
  busyTimer = setTimeout(() => {
    busyTimer = null
    if (fsm.current() === ClaudeState.BUSY) {
      log.warn('busy timeout (no activity), forcing IDLE')
      stopPaneWatcher()
      stopMirror()
      stopTyping()
      void endTurn('done')
      // No activity at all this turn ⇒ the send-keys was swallowed (TUI was
      // busy/wedged). Re-queue the in-flight message so it isn't lost.
      if (inflight) {
        log.warn('re-queuing swallowed message after busy timeout', { len: inflight.text.length })
        queue.push(inflight)
        inflight = null
      }
      fsm.forceIdle()
      void drain()
    }
  }, cfg.limits.busy_timeout_ms)
}

const disarmBusyTimer = (): void => {
  if (busyTimer) { clearTimeout(busyTimer); busyTimer = null }
}

const startPaneWatcher = (): void => {
  if (paneWatcher) return
  lastPaneFingerprint = ''
  paneWatcher = setInterval(() => {
    void (async () => {
      try {
        const pane = await tmux.capturePane()
        const fp = paneFingerprint(pane)
        if (fp !== lastPaneFingerprint) {
          lastPaneFingerprint = fp
          armBusyTimer()
        }
      } catch (err) {
        log.warn('capturePane failed', { error: String(err) })
      }
    })()
  }, PANE_TICK_MS)
}

const stopPaneWatcher = (): void => {
  if (paneWatcher) { clearInterval(paneWatcher); paneWatcher = null; lastPaneFingerprint = '' }
}

// ── Live terminal mirror ─────────────────────────────────────────────────────
// During a long/stuck turn, edit a single Telegram message every interval with
// the latest screen of the tmux pane (last N lines only — old lines drop off so
// the message never grows past Telegram's 4096-char cap). A delayed start keeps
// short turns clean; a stale marker flags a frozen/wedged session.
let mirrorTimer: ReturnType<typeof setInterval> | null = null
let mirrorStartTimer: ReturnType<typeof setTimeout> | null = null
let mirrorMsgId: number | null = null
let mirrorChat: number | null = null
let mirrorLastBody = ''
let mirrorLastChangeMs = 0
let mirrorLastSentHtml = ''
// Bumped by every stopMirror()/startMirror(). A mirror message is created with
// an async send; if stopMirror runs while that send is still in flight, the
// message is born AFTER its delete already ran and would hang forever. The tick
// captures the generation before sending and, if it changed by the time the id
// comes back, deletes its own orphan instead of leaking it.
let mirrorGen = 0
// When the current turn started — drives the "working — Ns" header on the mirror.
let turnStartMs = 0

const MIRROR_HARD_CAP = 3500
const MIRROR_STALE_MS = 90000

const formatMirror = (paneRaw: string, stale: boolean, elapsedSec: number): string => {
  // The pane can show `export FOO_TOKEN=…`, ps output, curl -H "Authorization: …"
  // — mask unambiguous credentials before the capture leaves the host.
  const pane = redactOutbound(paneRaw)
  let lines = pane.split('\n').map((l) => l.replace(/[ \t]+$/, ''))
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  while (lines.length && lines[0] === '') lines.shift()
  if (lines.length > cfg.mirror.max_lines) lines = lines.slice(-cfg.mirror.max_lines)
  let body = lines.join('\n')
  while (body.length > MIRROR_HARD_CAP && lines.length > 1) {
    lines.shift()
    body = lines.join('\n')
  }
  if (body.length > MIRROR_HARD_CAP) body = body.slice(-MIRROR_HARD_CAP)
  const name = escapeHtml(cfg.claude.tmux_session)
  const working = stale
    ? `⚠️ <b>завис</b> — ${elapsedSec}s · восстановить через <code>/new</code>`
    : `⏳ <b>работает</b> — ${elapsedSec}s`
  const head = `${working}\n🖥 <b>${name}</b> — терминал (живой)`
  return `${head}\n<pre>${escapeHtml(body) || '(пусто)'}</pre>`
}

const renderMirrorTick = async (): Promise<void> => {
  const chat = mirrorChat
  if (chat === null) return
  const gen = mirrorGen
  let pane: string
  try { pane = await tmux.capturePane() } catch { return }
  const bodyKey = pane.replace(/[ \t]+$/gm, '')
  const now = Date.now()
  if (bodyKey !== mirrorLastBody) { mirrorLastBody = bodyKey; mirrorLastChangeMs = now }
  const stale = now - mirrorLastChangeMs >= MIRROR_STALE_MS
  const elapsedSec = turnStartMs ? Math.round((now - turnStartMs) / 1000) : 0
  const html = formatMirror(pane, stale, elapsedSec)
  if (html === mirrorLastSentHtml) return
  try {
    if (mirrorMsgId === null) {
      const id = await bot.sendHtml(chat, html)
      // Race guard: the mirror was stopped while this send was in flight. The
      // just-created message is an orphan stopMirror could not see — delete it.
      if (gen !== mirrorGen || mirrorChat === null) {
        if (id !== null) void bot.deleteMessage(chat, id).catch(() => {})
        return
      }
      mirrorMsgId = id
    } else {
      await bot.editHtml(chat, mirrorMsgId, html)
    }
    mirrorLastSentHtml = html
  } catch (err) {
    log.warn('mirror update failed', { error: String(err) })
  }
}

const startMirror = (chatId: number): void => {
  if (!cfg.mirror.enabled) return
  stopMirror()
  mirrorChat = chatId
  mirrorLastBody = ''
  mirrorLastChangeMs = Date.now()
  mirrorLastSentHtml = ''
  mirrorStartTimer = setTimeout(() => {
    mirrorStartTimer = null
    void renderMirrorTick()
    mirrorTimer = setInterval(() => void renderMirrorTick(), cfg.mirror.interval_ms)
  }, cfg.mirror.start_delay_ms)
}

function stopMirror(): void {
  mirrorGen++ // invalidate any in-flight tick so a late send deletes its own orphan
  if (mirrorStartTimer) { clearTimeout(mirrorStartTimer); mirrorStartTimer = null }
  if (mirrorTimer) { clearInterval(mirrorTimer); mirrorTimer = null }
  const chat = mirrorChat
  const msg = mirrorMsgId
  mirrorChat = null
  mirrorMsgId = null
  mirrorLastBody = ''
  mirrorLastSentHtml = ''
  if (chat !== null && msg !== null) void bot.deleteMessage(chat, msg).catch(() => {})
}

const drain = async () => {
  if (fsm.current() !== ClaudeState.IDLE) return
  const next = queue.shift()
  if (!next) return
  const origin: InboundOrigin = { message_id: next.message_id, channel: next.channel }
  if (next.web_session_id) origin.web_session_id = next.web_session_id
  lastInbound.set(next.chat_id, origin)
  fsm.onSent()
  inflight = next // cleared on first real activity (pretool/stop); re-queued if the turn never starts
  turnStartMs = Date.now()
  const inMeta: Record<string, unknown> = { chat_id: next.chat_id, user_id: next.user_id }
  if (next.channel === 'telegram') inMeta.tg_message_id = next.message_id
  if (next.web_session_id) inMeta.web_session_id = next.web_session_id
  void dbInsertIn(next.channel, next.text, inMeta)
  void dbSetWorking(next.text.slice(0, 120))
  await startTurn(next.chat_id, next.channel, next.web_session_id)
  if (next.channel === 'telegram') startTyping(next.chat_id)
  await tmux.sendKeys(next.text)
  armBusyTimer()
  startPaneWatcher()
  startMirror(next.chat_id)
}

const uploadsDir = join(cfg.claude.workspace, '.tg-uploads')
mkdirSync(uploadsDir, { recursive: true })

const startedAtMs = Date.now()

const runCleanup = (): void => {
  if (cfg.uploads.ttl_days <= 0) return
  const r = cleanupUploads(uploadsDir, cfg.uploads.ttl_days * 24 * 60 * 60 * 1000)
  if (r.removed > 0) {
    log.info('uploads cleanup', { removed: r.removed, kept: r.kept, freedBytes: r.freedBytes })
  }
}
runCleanup()
setInterval(runCleanup, 24 * 60 * 60 * 1000)

function safeFilename(name: string): string {
  const b = basename(name)
  return b.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'file'
}

function tsPrefix(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
}

const saveIfFile = async (msg: {
  document?: { file_id: string; file_name?: string }
  photo?: Array<{ file_id: string; file_size?: number }>
  video?: { file_id: string; file_name?: string }
  audio?: { file_id: string; file_name?: string }
  voice?: { file_id: string }
}): Promise<string | null> => {
  const file = msg.document
    ?? msg.video
    ?? msg.audio
    ?? msg.voice
    ?? (msg.photo && msg.photo.length > 0 ? msg.photo[msg.photo.length - 1] : undefined)
  if (!file) return null
  try {
    const { buf, filename } = await downloadTelegramFile(cfg.telegram.bot_token, file.file_id)
    const hint = (msg.document?.file_name ?? msg.video?.file_name ?? msg.audio?.file_name ?? filename)
    const name = safeFilename(hint)
    const savePath = join(uploadsDir, `${tsPrefix()}-${name}`)
    writeFileSync(savePath, Buffer.from(buf))
    log.info('file saved', { path: savePath, bytes: buf.byteLength })
    return savePath
  } catch (err) {
    log.warn('file save failed', { error: String(err) })
    return null
  }
}

const formatUptime = (ms: number): string => {
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}

const renderStatus = (): string => {
  const uptime = formatUptime(Date.now() - startedAtMs)
  const state = fsm.current()
  const qd = queue.size()
  const activeChat = active?.chatId ?? null
  const activeElapsed = active ? active.tracker.elapsedSec() : null
  const lines = [
    `tg-bridge @ ${cfg.claude.tmux_session}`,
    `uptime  ${uptime}`,
    `state   ${state}`,
    `queue   ${qd}`,
    `streaming ${cfg.streaming.mode}`,
    activeChat !== null ? `turn    chat=${activeChat} elapsed=${activeElapsed}s` : 'turn    -',
  ]
  return `<pre>${lines.join('\n')}</pre>`
}

const transcribeIfVoice = async (msg: {
  voice?: { file_id: string; duration?: number }
  audio?: { file_id: string }
}): Promise<string | null> => {
  const fileId = msg.voice?.file_id ?? msg.audio?.file_id
  if (!fileId) return null
  if (!cfg.voice.groq_api_key_file) {
    log.warn('voice received but GROQ_API_KEY_FILE unset')
    return null
  }
  try {
    const key = loadGroqKey(cfg.voice.groq_api_key_file)
    const { buf, filename } = await downloadTelegramFile(cfg.telegram.bot_token, fileId)
    const mime = filename.endsWith('.ogg') || filename.endsWith('.oga')
      ? 'audio/ogg'
      : 'audio/mpeg'
    const text = await transcribeAudio({ apiKey: key, audio: buf, filename, mimeType: mime })
    log.info('voice transcribed', { len: text.length })
    return text
  } catch (err) {
    log.warn('voice transcription failed', { error: String(err) })
    return null
  }
}

// Yes/no words that resolve a pending permission prompt when typed as text
// (inline Allow/Deny buttons don't render on some clients — see relay.ts).
const PERM_YES_RE = /^(да|ага|ок|окей|yes|y|ok|allow|разреш\w*|давай|можно|подтверждаю|\+)$/i
const PERM_NO_RE = /^(нет|не|no|n|deny|запрет\w*|отмена|стоп|нельзя|-)$/i

// True when the message was forwarded into the chat (any Telegram variant).
const isForwarded = (m: {
  forward_origin?: unknown; forward_from?: unknown
  forward_from_chat?: unknown; forward_sender_name?: unknown
}): boolean =>
  !!(m.forward_origin || m.forward_from || m.forward_from_chat || m.forward_sender_name)

// Human label of the original author of a forwarded message, or null if hidden.
const forwardOriginLabel = (m: {
  forward_origin?: {
    type: string
    sender_user?: { first_name?: string; username?: string }
    sender_user_name?: string
    sender_chat?: { title?: string; username?: string }
    chat?: { title?: string; username?: string }
  }
  forward_from?: { first_name?: string; username?: string }
  forward_from_chat?: { title?: string; username?: string }
  forward_sender_name?: string
}): string | null => {
  const o = m.forward_origin
  if (o) {
    if (o.type === 'user' && o.sender_user)
      return o.sender_user.first_name ?? o.sender_user.username ?? 'пользователь'
    if (o.type === 'hidden_user') return o.sender_user_name ?? 'скрытый пользователь'
    if (o.type === 'channel' && o.chat) return o.chat.title ?? o.chat.username ?? 'канал'
    if (o.type === 'chat' && o.sender_chat)
      return o.sender_chat.title ?? o.sender_chat.username ?? 'чат'
  }
  if (m.forward_from) return m.forward_from.first_name ?? m.forward_from.username ?? 'пользователь'
  if (m.forward_from_chat) return m.forward_from_chat.title ?? m.forward_from_chat.username ?? 'чат'
  if (m.forward_sender_name) return m.forward_sender_name
  return null
}

// Bot API 10.1+ rich messages (sendRichMessage) arrive without `text`/`caption`;
// the content lives in `rich_message.blocks`. Forwards of such messages (e.g.
// another bot's report) used to be dropped silently. Flatten them to plain text.
const richTextToPlain = (rt: unknown): string => {
  if (typeof rt === 'string') return rt
  if (Array.isArray(rt)) return rt.map(richTextToPlain).join('')
  if (rt && typeof rt === 'object') {
    const o = rt as Record<string, unknown>
    if (o.text !== undefined) return richTextToPlain(o.text)
    if (typeof o.label === 'string') return o.label
  }
  return ''
}
const richBlocksToPlain = (blocks: unknown): string => {
  if (!Array.isArray(blocks)) return ''
  const out: string[] = []
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue
    const o = b as Record<string, unknown>
    switch (o.type) {
      case 'list':
        for (const it of (Array.isArray(o.items) ? o.items : []) as Array<Record<string, unknown>>) {
          const body = richBlocksToPlain(it.blocks)
          out.push(`${typeof it.label === 'string' && it.label ? it.label : '-'} ${body}`.trim())
        }
        break
      case 'table':
        for (const row of (Array.isArray(o.cells) ? o.cells : []) as Array<Array<Record<string, unknown>>>) {
          out.push(row.map((c) => richTextToPlain(c?.text)).join(' | '))
        }
        if (o.caption) out.push(richTextToPlain(o.caption))
        break
      case 'divider':
        out.push('---')
        break
      default: {
        if (o.summary) out.push(richTextToPlain(o.summary))
        const t = richTextToPlain(o.text)
        if (t) out.push(t)
        if (o.blocks) out.push(richBlocksToPlain(o.blocks))
        if (o.caption) out.push(richTextToPlain(o.caption))
      }
    }
  }
  return out.filter((x) => x.trim()).join('\n')
}

const onTelegramMessage = async (msg: {
  from?: { id: number; username?: string; first_name?: string }
  chat: { id: number }
  text?: string
  caption?: string
  rich_message?: { blocks?: unknown[] }
  voice?: { file_id: string; duration?: number }
  audio?: { file_id: string }
  document?: { file_id: string; file_name?: string }
  photo?: Array<{ file_id: string; file_size?: number }>
  video?: { file_id: string; file_name?: string }
  // Forwarded-message markers. grammY delivers these on the raw message object;
  // forward_origin is the modern (Bot API 7.0+) shape, the rest are legacy
  // fields still sent for backward compat. The bridge reads them so a forward
  // is presented to the agent as "Alexander handed you this", not as a stray
  // line from a third party that the agent shrugs off.
  forward_origin?: {
    type: string
    sender_user?: { first_name?: string; username?: string }
    sender_user_name?: string
    sender_chat?: { title?: string; username?: string }
    chat?: { title?: string; username?: string }
  }
  forward_from?: { first_name?: string; username?: string }
  forward_from_chat?: { title?: string; username?: string }
  forward_sender_name?: string
  message_id: number
}) => {
  if (!msg.from) return
  const gate = allowMessage(
    { from_id: msg.from.id, chat_id: msg.chat.id },
    { user_ids: cfg.telegram.allowed_user_ids, chat_ids: cfg.telegram.allowed_chat_ids },
  )
  if (gate !== 'allow') {
    log.info('denied', { reason: gate, user_id: msg.from.id })
    return
  }
  const cmd = (msg.text ?? '').trim().toLowerCase()
  if (cmd === '/status') {
    await bot.sendHtml(msg.chat.id, renderStatus())
    return
  }
  // Bridge control commands. These must be handled here (not forwarded into the
  // pane) because when the TUI is wedged, send-keys into Claude is ignored.
  if (cmd === '/stop') {
    // Soft interrupt: Escape into the pane + reset bridge turn state to IDLE so
    // the next message can drain. If the input loop is wedged, use /new instead.
    disarmBusyTimer()
    stopPaneWatcher()
    stopMirror()
    stopTyping()
    awaitingUserTool = null
    clearAwaitingModal(true)
    inflight = null // operator interrupted ⇒ don't re-queue the in-flight message
    await tmux.sendEscape().catch(() => {})
    await endTurn('done')
    fsm.forceIdle()
    void dbSetIdle()
    await bot.sendHtml(msg.chat.id, "⏹ Отправлен Escape, состояние IDLE. Если завис — <code>/new</code> сделает hard restart.")
    void drain()
    return
  }
  if (cmd === '/new' || cmd === '/reset' || cmd === '/clear' || cmd === '/kill') {
    // Hard restart: kill + respawn the Claude process and wipe all bridge state.
    // Works even when the TUI input loop is dead (the failure mode where typed
    // /stop and /clear are silently ignored).
    disarmBusyTimer()
    stopPaneWatcher()
    stopMirror()
    stopTyping()
    awaitingUserTool = null
    clearAwaitingModal(true)
    inflight = null // hard reset wipes all pending state
    await endTurnAndDelete()
    while (queue.shift()) { /* drain pending */ }
    fsm.forceIdle()
    void dbSetIdle()
    try {
      await tmux.hardRestart()
      await bot.sendHtml(msg.chat.id, "🔄 Сессия Claude перезапущена (чистый контекст).")
    } catch (err) {
      log.warn('hard restart failed', { error: String(err) })
      await bot.sendHtml(msg.chat.id, "⚠️ ошибка рестарта: " + escapeHtml(String(err)))
    }
    return
  }
  // Text-reply to a pending permission prompt. When the relay is blocking on a
  // verdict, the agent is mid-tool-call (FSM BUSY) and a normal queue.push would
  // never drain — so a bare "да"/"нет" here is the answer to that prompt, not a
  // new instruction. Only the gated owner reaches this (gate checked above).
  if (relay.pendingCount() > 0) {
    const t = (msg.text ?? '').trim()
    if (PERM_YES_RE.test(t)) {
      relay.answerLatest('allow')
      void bot.setReaction(msg.chat.id, msg.message_id, 'check').catch(() => {})
      return
    }
    if (PERM_NO_RE.test(t)) {
      relay.answerLatest('deny')
      void bot.setReaction(msg.chat.id, msg.message_id, 'cross').catch(() => {})
      return
    }
  }
  let text = msg.text ?? msg.caption ?? ''
  if (!text && msg.rich_message) text = richBlocksToPlain(msg.rich_message.blocks)
  const savedPath = await saveIfFile(msg)
  if (savedPath) {
    const prefix = `Оператор прислал файл: ${savedPath}`
    text = text ? `${prefix}\n${text}` : prefix
  }
  // Voice/audio is both saved to disk (savedPath above) and transcribed:
  // the transcript stays the operator's actual input, the file lets the agent
  // work with the raw audio (music recognition, tone, re-listening).
  if (!text || msg.voice || msg.audio) {
    const transcript = await transcribeIfVoice(msg)
    if (transcript) text = text ? `${text}\n${transcript}` : transcript
  }
  if (!text) {
    log.warn('inbound message dropped: no extractable text', { keys: Object.keys(msg), forwarded: isForwarded(msg) })
    return
  }
  if (isForwarded(msg)) {
    const origin = forwardOriginLabel(msg)
    const src = origin ? ` (исходный автор: ${origin})` : ''
    text = `[Александр переслал тебе это сообщение${src}. Это ввод от Александра — прочитай и обработай/ответь по сути, не считай чужой перепиской и не пропускай.]\n\n${text}`
  }
  if (cfg.features.inject_sender_identity) {
    text = injectSenderPrefix({
      text,
      user_id: msg.from.id,
      username: msg.from.username,
      first_name: msg.from.first_name,
      owner_ids: cfg.features.owner_user_ids,
    })
  }
  void bot.setReaction(msg.chat.id, msg.message_id, 'eyes').catch(() => {})
  // If Claude is sitting in an AskUserQuestion / ExitPlanMode modal, the FSM
  // is BUSY and queue.push won't drain. Route the operator's text straight
  // into the tmux pane so the modal consumes it as the answer.
  if (awaitingUserTool) {
    log.info('routing message into active modal', { tool: awaitingUserTool, text_len: text.length })
    await tmux.sendKeys(text)
    // Answered the option-question by typing — drop the surfaced question and
    // this answer message (only this modal's; the rest of the chat stays).
    clearAwaitingModal(true)
    void bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {})
    return
  }
  const dropped = queue.push({
    chat_id: msg.chat.id,
    user_id: msg.from.id,
    text,
    message_id: msg.message_id,
    channel: 'telegram',
  })
  if (dropped) log.warn('queue overflow, dropped oldest')
  await drain()
}

const ownerChatId =
  cfg.features.owner_user_ids[0] ??
  cfg.telegram.allowed_user_ids[0] ??
  0

// The outbound reply must reach the human operator's Telegram chat. Swarm
// pushes (agent-to-agent) are enqueued for context but carry their own chat_id
// — often a stale/legacy owner id — and would otherwise become the last key in
// `lastInbound`, hijacking the reply target and causing "chat not found".
// Pick the most recent NON-swarm inbound; fall back to the owner chat.
const resolveReplyTarget = (): { chat: number | undefined; origin: InboundOrigin | undefined } => {
  const human = Array.from(lastInbound.entries())
    .filter(([, o]) => (o.channel ?? 'telegram') !== 'swarm')
    .pop()
  if (human) return { chat: human[0], origin: human[1] }
  return { chat: ownerChatId || undefined, origin: undefined }
}

const relay = createRelay({
  sendPrompt: async (chatId, text, reqId) => {
    await bot.raw.api.sendMessage(chatId, text, {
      reply_markup: {
        inline_keyboard: [[
          { text: 'Allow', callback_data: `perm:${reqId}:allow` },
          { text: 'Deny', callback_data: `perm:${reqId}:deny` },
        ]],
      },
    })
  },
  ownerChatId,
  timeoutMs: cfg.limits.permission_timeout_ms,
  defaultDecision: cfg.limits.permission_default,
})

// --- Login watchdog --------------------------------------------------------
// Claude Code OAuth tokens expire on a long-running session (token rotation
// race when several agents share one Max account, manual logout, etc). On
// expiry the live session goes silent — no hook fires, the pane just shows
// "Please run /login · API Error: 401" and the operator notices only by
// manually attaching. This independent probe captures the pane on an interval
// (works even while IDLE) and alerts the owner exactly once per outage.
const AUTH_FAIL_RE =
  /please run \/login|api error: 401|invalid authentication|unauthorized request|oauth token has expired/i
// Debounce: the pane also renders the live conversation, so a chat that merely
// mentions "401" / "please run /login" would match. A real outage stays pinned;
// a chat mention scrolls away. Require two CONSECUTIVE matching captures before
// alerting — kills false positives from talking about auth, keeps genuine slips.
const AUTH_STREAK_TO_ALERT = 2
let authAlerted = false
let authStreak = 0
if (cfg.limits.login_watchdog_ms > 0) {
  setInterval(() => {
    void (async () => {
      try {
        const pane = await tmux.capturePane()
        if (AUTH_FAIL_RE.test(pane)) {
          authStreak += 1
          if (authStreak >= AUTH_STREAK_TO_ALERT && !authAlerted) {
            authAlerted = true
            log.warn('auth failure detected in pane — login required', {
              session: cfg.claude.tmux_session,
              streak: authStreak,
            })
            if (ownerChatId) {
              await bot.sendHtml(
                ownerChatId,
                `⚠️ <b>tg-bridge: слетела авторизация Claude</b>\n\n` +
                  `Агент <code>${cfg.claude.tmux_session}</code> не достучался до API (401 / нужен /login). Бот молчит.\n\n` +
                  `Починить:\n<pre>tmux -L ${cfg.claude.tmux_socket} attach -t ${cfg.claude.tmux_session}\n# в prompt: /login → открыть URL → код обратно\n# выйти: Ctrl-B затем D</pre>`,
              )
            }
          }
        } else {
          authStreak = 0
          authAlerted = false // session healthy again — re-arm for next outage
        }
      } catch (err) {
        log.warn('login watchdog capturePane failed', { error: String(err) })
      }
    })()
  }, cfg.limits.login_watchdog_ms)
  log.info('login watchdog armed', { interval_ms: cfg.limits.login_watchdog_ms })
}

const server = await startHttpServer({
  host: cfg.bridge.host,
  port: cfg.bridge.port,
  bearerToken: cfg.bridge.bearer_token,
  onGbrainPush: async (body) => {
    const b = body as {
      chat_id?: number; user_id?: number; text?: string
      chatId?: number; message?: string
      agentId?: string; from_agent?: string
      channel?: string; web_session_id?: string
      attachments?: Array<{ path?: string; name?: string; kind?: string }>
    }
    const chat_id = b.chat_id ?? b.chatId ?? cfg.features.owner_user_ids[0]
    let text = b.text ?? b.message ?? ''
    if (Array.isArray(b.attachments) && b.attachments.length > 0) {
      const lines = b.attachments
        .filter((a) => a && typeof a.path === 'string' && a.path.length > 0)
        .map((a) => `Оператор прислал файл: ${a.path}`)
      if (lines.length > 0) text = (text ? text + '\n' : '') + lines.join('\n')
    }
    // Infer channel: explicit `channel` wins; else agentId/from_agent ⇒ swarm push;
    // else default to telegram. Swarm pushes don't have a Telegram user_id —
    // fall back to chat_id (owner's id == chat_id in personal chats).
    const rawChannel = (b.channel ?? (b.agentId || b.from_agent ? 'swarm' : 'telegram')).toLowerCase()
    const channel: QueueChannel =
      rawChannel === 'web' || rawChannel === 'swarm' ? rawChannel : 'telegram'
    const user_id = b.user_id ?? chat_id
    if (!chat_id || !user_id || !text) return { status: 400, body: { error: 'bad payload' } }
    log.info('gbrain push', { chat_id, channel, text_len: text.length, attachments: b.attachments?.length ?? 0, from_agent: b.from_agent ?? b.agentId ?? null })
    const item: QueueItem = { chat_id, user_id, text, message_id: 0, channel }
    if (b.web_session_id) item.web_session_id = b.web_session_id
    queue.push(item)
    void drain()
    return { status: 200, body: { status: 'accepted' } }
  },
  onStop: async (body) => {
    const { assistant_message } = await handleStopHook(body as { transcript_path?: string })
    inflight = null // the turn produced a reply ⇒ it genuinely ran; no re-queue needed
    const { chat: targetChat, origin } = resolveReplyTarget()
    log.info('stop hook', { msg_len: assistant_message.length, chat: targetChat })
    const { text, reactions, buttons, files } = parseReply(assistant_message)
    const targetMsg = origin?.message_id
    const originChannel: QueueChannel = origin?.channel ?? 'telegram'
    disarmBusyTimer()
    stopPaneWatcher()
    stopMirror()
    stopTyping()
    if (targetChat !== undefined && (text.length > 0 || files.length > 0)) {
      await endTurnAndDelete()
      // Hybrid send-to-Telegram: always (originChannel='web' linked mode keeps
      // the operator's TG chat in the loop). DB-mirror happens below.
      if (text.length > 0) {
        // Precision credential masking (bot tokens, sk-/ghp_/JWT/Bearer …) —
        // NOT the broad progress-mask: full addresses/IPs/urls must survive.
        const safeText = redactOutbound(text)
        if (buttons.length > 0) {
          await bot.sendButtons(targetChat, safeText, buttons)
        } else {
          // Rich-first: send raw markdown via sendRichMessage (native headings/
          // tables/lists, 32768-char limit). Fall back to the proven HTML path
          // (then plain chunked) if the rich method is unavailable or errors.
          // RICH_MESSAGES=off skips rich entirely so text stays copyable.
          const okRich = cfg.features.rich_messages
            ? await bot.sendRich(targetChat, safeText)
            : false
          if (!okRich) {
            const html = formatReplyHtml(safeText)
            const sent = await bot.sendHtml(targetChat, html)
            if (sent === null) await bot.sendText(targetChat, safeText)
          }
        }
      }
      for (const f of files) {
        if (!existsSync(f.path)) {
          log.warn('FILE marker path missing', { path: f.path })
          continue
        }
        const route = routeFile(f, targetChat, cfg.proactive.file_chats)
        if (route.action === 'drop') {
          log.warn('FILE marker dropped', { path: f.path, chat: f.chat ?? null, reason: route.reason })
          continue
        }
        await bot.sendFile(route.chat, f)
      }
      if (originChannel === 'telegram') {
        if (reactions.length === 0 && targetMsg !== undefined) {
          await bot.setReaction(targetChat, targetMsg, 'thumbsup')
        } else {
          for (const r of reactions) {
            if (targetMsg !== undefined) await bot.setReaction(targetChat, targetMsg, r)
          }
        }
      }
      const outMeta: Record<string, unknown> = { chat_id: targetChat }
      if (origin?.web_session_id) outMeta.web_session_id = origin.web_session_id
      if (buttons.length > 0) outMeta.buttons = buttons
      if (files.length > 0) outMeta.files = files.map((f) => ({ path: f.path, kind: f.kind ?? null }))
      if (text.length > 0 || files.length > 0) {
        const dbText = text.length > 0 ? text : files.map((f) => `[file] ${f.path}`).join('\n')
        void dbInsertOut(originChannel, dbText, outMeta)
      }
    } else {
      await endTurn('done')
    }
    void dbSetIdle()
    fsm.onStop()
    void drain()
    return { status: 200, body: { ok: true } }
  },
  onPostTool: async (body) => {
    const b = body as { tool_name?: string; tool_input?: Record<string, unknown>; tool?: string; args?: Record<string, unknown> }
    const tool = b.tool_name ?? b.tool
    const args = b.tool_input ?? b.args ?? {}
    if (!tool) return { status: 200, body: { ok: true } }
    if (awaitingUserTool && tool === awaitingUserTool) {
      log.info('user answered, resuming heartbeat', { tool })
      awaitingUserTool = null
      // Modal resolved (possibly answered straight in the TUI) — drop any stale
      // surfaced question still sitting in the chat.
      clearAwaitingModal(true)
    }
    armBusyTimer()
    if (active) startPaneWatcher()
    if (!active || cfg.streaming.mode !== 'progress') return { status: 200, body: { ok: true } }
    active.tracker.onTool(tool, args)
    scheduleEdit(active)
    return { status: 200, body: { ok: true } }
  },
  onPreTool: async (body) => {
    const b = body as {
      tool_name?: string
      tool_input?: Record<string, unknown>
      tool?: string
      args?: Record<string, unknown>
    }
    const toolName = b.tool_name ?? b.tool
    const toolArgs = b.tool_input ?? b.args ?? {}
    if (!toolName) {
      return {
        status: 200,
        body: {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            permissionDecisionReason: 'no tool name; passthrough',
          },
        },
      }
    }
    if (AWAITING_USER_TOOLS.has(toolName)) {
      awaitingUserTool = toolName
      disarmBusyTimer()
      stopPaneWatcher()
      log.info('awaiting user input — heartbeat frozen', { tool: toolName })
      const surfaceChat = resolveReplyTarget().chat
      if (surfaceChat !== undefined) {
        void (async () => {
          try {
            const html = renderAwaitingUserPrompt(toolName, toolArgs)
            if (html) {
              const msgId = await bot.sendHtml(surfaceChat, html)
              if (msgId !== null) awaitingModal = { chat: surfaceChat, msgId }
              log.info('modal surfaced to telegram', { chat: surfaceChat, msg_id: msgId })
            } else {
              log.warn('renderAwaitingUserPrompt returned null', { tool: toolName })
            }
          } catch (err) {
            log.warn('failed to surface awaiting-user prompt', { error: String(err) })
          }
        })()
      } else {
        log.warn('no surface chat available — modal not delivered to telegram', { tool: toolName })
      }
    } else {
      if (awaitingUserTool) {
        log.info('user activity detected, resuming heartbeat', { prev: awaitingUserTool })
        awaitingUserTool = null
        clearAwaitingModal(true)
      }
      armBusyTimer()
      if (active) startPaneWatcher()
    }
    if (toolName === 'Task' && active && cfg.streaming.mode === 'progress') {
      active.tracker.onTaskStart(toolArgs)
      scheduleEdit(active)
    }
    inflight = null // a tool fired ⇒ the turn genuinely started; no re-queue needed
    const inv = { tool: toolName, args: toolArgs }
    log.info('pretool', { tool: toolName, relay: needsRelay(inv, policy) })
    if (!needsRelay(inv, policy)) {
      return {
        status: 200,
        body: {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            permissionDecisionReason: 'policy: passthrough',
          },
        },
      }
    }
    if (fsm.current() === ClaudeState.BUSY) fsm.onPreTool()
    const verdict = await relay.requestVerdict(inv)
    if (fsm.current() === ClaudeState.WAITING_PERMISSION) fsm.onPermissionVerdict()
    return {
      status: 200,
      body: {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: verdict,
          permissionDecisionReason: `tg-bridge relay verdict: ${verdict}`,
        },
      },
    }
  },
})

log.info('http listening', { port: server.port })

await bot.start(async (update) => {
  const u = update as {
    message?: Parameters<typeof onTelegramMessage>[0]
    callback_query?: {
      id?: string
      data?: string
      from: { id: number }
      message?: { chat: { id: number }; message_id: number }
    }
  }
  // DIAG-FORWARD-20260620: temporary raw-update probe. Logs the shape of every
  // update so we can see whether a forwarded message reaches the bridge at all
  // and which fields it carries. Remove once forward handling is confirmed.
  try {
    const raw = update as Record<string, unknown>
    const m = raw.message as Record<string, unknown> | undefined
    log.info('DIAG raw update', {
      update_keys: Object.keys(raw),
      has_message: !!m,
      msg_keys: m ? Object.keys(m) : null,
      text_len: m ? String((m.text ?? m.caption ?? '')).length : 0,
      from_id: m ? (m.from as { id?: number } | undefined)?.id : null,
      chat_id: m ? (m.chat as { id?: number } | undefined)?.id : null,
    })
  } catch { /* never let diag break the handler */ }
  if (u.message) await onTelegramMessage(u.message)
  if (u.callback_query?.data) {
    const data = u.callback_query.data
    const fromId = u.callback_query.from.id
    const perm = data.match(/^perm:([0-9a-f-]+):(allow|deny)$/)
    if (perm && cfg.features.owner_user_ids.includes(fromId)) {
      const reqId = perm[1]
      const decision = perm[2] as 'allow' | 'deny'
      if (reqId) relay.callbackAnswer(reqId, decision)
    } else if (data.startsWith('abtn:')) {
      const payload = data.slice(5)
      const chatId = u.callback_query.message?.chat.id
      const msgId = u.callback_query.message?.message_id
      const gate = chatId !== undefined && allowMessage(
        { from_id: fromId, chat_id: chatId },
        { user_ids: cfg.telegram.allowed_user_ids, chat_ids: cfg.telegram.allowed_chat_ids },
      ) === 'allow'
      if (gate && chatId !== undefined && msgId !== undefined) {
        if (u.callback_query.id) {
          await bot.raw.api.answerCallbackQuery(u.callback_query.id, { text: payload }).catch(() => {})
        }
        // Answer chosen — the question is in the mirror, so drop the surfaced
        // option-question message instead of just clearing its buttons.
        await bot.deleteMessage(chatId, msgId)
        if (awaitingModal?.msgId === msgId) awaitingModal = null
        queue.push({ chat_id: chatId, user_id: fromId, text: payload, message_id: msgId, channel: 'telegram' })
        void drain()
      }
    }
  }
})

log.info('bot polling started', { bot_id: cfg.telegram.bot_id })

// Health watchdog (fix B, FIX-POLL-WATCHDOG-2026-08-13.md). Covers API-path
// degradation the poller can't see from inside: getMe goes through timedFetch,
// so a dead backend surfaces as an error within its timeout budget instead of
// hanging. Three consecutive failures -> exit(1), systemd's Restart=on-failure
// brings the bridge back with a fresh network stack.
// Storm guard: during a provider-side outage measured in hours (2026-08-13 was
// ~3h, and restarts provably don't help — the failure sits past Telegram's
// edge) an exit every ~3 minutes is pure churn, so after 5 watchdog exits
// inside 30 minutes the watchdog stops exiting and keeps logging until the API
// answers again. Exit timestamps persist across restarts in the state file.
const HEALTH_INTERVAL_MS = 60_000
// Env-overridable: when Telegram is throttling THIS token, restarting only feeds the
// throttle. Keep the process up and let it keep retrying instead of exiting.
const HEALTH_EXIT_THRESHOLD = Number(process.env.BRIDGE_HEALTH_EXIT_THRESHOLD ?? 3)
const STORM_WINDOW_MS = 30 * 60_000
const STORM_MAX_EXITS = 5
const healthStateFile = join(homedir(), '.local', 'state', 'tg-bridge-a2', `health-exits-${cfg.telegram.bot_id}.json`)

function readHealthExits(): number[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(healthStateFile, 'utf8'))
    return Array.isArray(parsed) ? parsed.filter((t): t is number => typeof t === 'number') : []
  } catch {
    return []
  }
}

function writeHealthExits(ts: number[]): void {
  try {
    mkdirSync(dirname(healthStateFile), { recursive: true })
    writeFileSync(healthStateFile, JSON.stringify(ts))
  } catch (err) {
    log.warn('health watchdog: cannot persist exit timestamps', { error: String(err) })
  }
}

let healthFailures = 0
setInterval(async () => {
  try {
    await bot.getMe()
    if (healthFailures > 0) log.info('telegram api health recovered', { after_failures: healthFailures })
    healthFailures = 0
  } catch (err) {
    healthFailures++
    log.warn('telegram api health check failed', { n: healthFailures, error: String(err) })
    if (healthFailures < HEALTH_EXIT_THRESHOLD) return
    const recentExits = readHealthExits().filter((t) => Date.now() - t < STORM_WINDOW_MS)
    if (recentExits.length >= STORM_MAX_EXITS) {
      // Log at a low duty cycle — once per ~5 checks — so a multi-hour outage
      // does not flood bridge.err while the guard holds the process alive.
      if (healthFailures % 5 === 0) {
        log.error('health watchdog: API still unreachable, storm guard active — staying up', {
          consecutive_failures: healthFailures,
          exits_last_30m: recentExits.length,
        })
      }
      return
    }
    writeHealthExits([...recentExits, Date.now()])
    log.error('health watchdog: consecutive failures reached threshold, exiting for systemd restart', {
      consecutive_failures: healthFailures,
    })
    process.exit(1)
  }
}, HEALTH_INTERVAL_MS)

const shutdown = async () => {
  log.info('shutting down')
  await bot.stop()
  await server.stop()
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())
