import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Real Bash loop, failed inotifywait, then a message arriving after failure.
// No tmux/Claude/Telegram processes or production state are involved.
test('watcher polls and delivers after repeated inotifywait errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'watcher-resilience-'))
  const entry = join(import.meta.dir, '../../src/claude/chat-entrypoint.sh')
  const script = `
    CHAT_ENTRYPOINT_TEST_ONLY=1 source "$ENTRY"
    INBOX="$DIR"; PROCESSED="$DIR/.processed"; PANE=test
    mkdir -p "$PROCESSED"
    count=0
    inotifywait() {
      count=$((count + 1))
      if [[ "$count" == 2 ]]; then
        printf '%s' '{"text":"message after failure"}' > "$INBOX/late.json"
      fi
      return 1
    }
    sleep() { command sleep 0.02; }
    submit_prompt() { printf '%s' "$1" > "$INBOX/delivered"; }
    parent_alive() { :; }
    # Stop the loop after successful delivery without killing any process.
    kill() { [[ ! -f "$INBOX/delivered" ]]; }
    run_inbox_watcher "$$"
  `
  writeFileSync(join(dir, 'test.sh'), script)
  const proc = Bun.spawn(['bash', join(dir, 'test.sh')], {
    env: { ...process.env, ENTRY: entry, DIR: dir }, stdout: 'pipe', stderr: 'pipe',
  })
  const timeout = setTimeout(() => proc.kill(), 5000)
  try {
    expect(await proc.exited).toBe(0)
    expect(readFileSync(join(dir, 'delivered'), 'utf8')).toBe('message after failure')
    expect(JSON.parse(readFileSync(join(dir, '.processed/late.json'), 'utf8')).text)
      .toBe('message after failure')
  } finally { clearTimeout(timeout) }
})

async function bashCase(body: string) {
  const dir = mkdtempSync(join(tmpdir(), 'watcher-regression-'))
  const proc = Bun.spawn(['bash', '-c', `
    CHAT_ENTRYPOINT_TEST_ONLY=1 source "$ENTRY"
    INBOX="$DIR"; PROCESSED="$DIR/.processed"
    mkdir -p "$PROCESSED"
    printf '%s' '{"text":"regression message"}' > "$INBOX/one.json"
    ${body}
  `], { env: { ...process.env, DIR: dir,
    ENTRY: join(import.meta.dir, '../../src/claude/chat-entrypoint.sh') },
    stdout: 'pipe', stderr: 'pipe' })
  expect(await proc.exited).toBe(0)
}

test('archive failure retries archive, not a confirmed submission', async () => {
  await bashCase(`
    deliveries=0; archives=0
    submit_prompt() { deliveries=$((deliveries + 1)); }
    archive_inbox_file() {
      archives=$((archives + 1))
      [[ "$archives" -gt 1 ]] || return 1
      command mv "$1" "$2"
    }
    process_inbox || true
    process_inbox
    [[ "$deliveries" == 1 && "$archives" == 2 && -f "$PROCESSED/one.json" ]]
  `)
})

test('parent dying during submit leaves the message for the next pane', async () => {
  await bashCase(`
    alive=1
    parent_alive() { [[ "$alive" == 1 ]]; }
    submit_prompt() { alive=0; return 1; }
    process_inbox || true
    [[ -f "$INBOX/one.json" && ! -f "$PROCESSED/submit-unconfirmed-one.json" ]]
  `)
})

test('inbox busy timeout does not enqueue another persistent copy', () => {
  const source = readFileSync(join(import.meta.dir, '../../src/server.ts'), 'utf8')
  const start = source.indexOf('const armBusyTimer =')
  const end = source.indexOf('const disarmBusyTimer =', start)
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end))
  for (const channel of ['inbox', 'send-keys']) {
    let callback = () => {}
    let copies = 0
    const makeTimer = new Function('cfg', 'fsm', 'ClaudeState', 'log', 'queue',
      'setTimeout', 'clearTimeout', 'stopPaneWatcher', 'stopMirror', 'stopTyping',
      'endTurn', 'alertIfUsageLimit', 'drain', `
      let busyTimer = null; let inflight = {text: 'original'};
      ${js}
      armBusyTimer();
    `)
    const noop = () => {}
    makeTimer({ claude: { input_channel: channel }, limits: { busy_timeout_ms: 1 } },
      { current: () => 'BUSY', forceIdle: noop }, { BUSY: 'BUSY' }, { warn: noop },
      { push: () => copies++ }, (fn: () => void) => { callback = fn; return 1 },
      noop, noop, noop, noop, noop, noop, noop)
    callback()
    expect(copies).toBe(channel === 'inbox' ? 0 : 1)
  }
})
