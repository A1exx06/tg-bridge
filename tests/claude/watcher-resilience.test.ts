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
