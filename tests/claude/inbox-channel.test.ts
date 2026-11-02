import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTmuxSession } from '../../src/claude/tmux-session.js'

// Inbox-channel input path (feature/inbox-channel, plan B). In inbox mode
// sendKeys() persists an inbox JSON and NEVER touches tmux, so these tests
// exercise the real code with no tmux server / no claude process.

describe('inbox-channel: sendKeys persists instead of send-keys', () => {
  let dir: string
  let inboxDir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'inbox-channel-test-'))
    inboxDir = join(dir, 'inbox')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function makeSession() {
    return createTmuxSession({
      socket: 'test-sock',
      session: 'test-sess',
      cwd: dir,
      inboxDir,
      buildCommand: () => 'claude --session-id test',
    })
  }

  test('writes one committed *.json with the exact text, no leftover .tmp', async () => {
    await makeSession().sendKeys('сколько стоит перевод 10000 USDT?')

    const all = readdirSync(inboxDir)
    const jsons = all.filter((f) => f.endsWith('.json'))
    const tmps = all.filter((f) => f.endsWith('.tmp'))

    expect(jsons.length).toBe(1)
    expect(tmps.length).toBe(0) // rename() left no half-written sibling
    const payload = JSON.parse(readFileSync(join(inboxDir, jsons[0] as string), 'utf8'))
    expect(payload.text).toBe('сколько стоит перевод 10000 USDT?')
  })

  test('inbox file is 0600 (not world-readable)', async () => {
    await makeSession().sendKeys('secret-ish message')
    const jsons = readdirSync(inboxDir).filter((f) => f.endsWith('.json'))
    const mode = statSync(join(inboxDir, jsons[0] as string)).mode & 0o777
    expect(mode).toBe(0o600)
  })

  test('two messages produce two distinct files (unique ids)', async () => {
    const s = makeSession()
    await s.sendKeys('first')
    await s.sendKeys('second')
    const jsons = readdirSync(inboxDir).filter((f) => f.endsWith('.json'))
    expect(jsons.length).toBe(2)
    const texts = jsons
      .map((f) => JSON.parse(readFileSync(join(inboxDir, f), 'utf8')).text)
      .sort()
    expect(texts).toEqual(['first', 'second'])
  })

  test('creates inbox dir on demand when absent', async () => {
    // inboxDir does not exist yet — writeToInbox must mkdir -p it.
    expect(readdirSync(dir).includes('inbox')).toBe(false)
    await makeSession().sendKeys('bootstrap')
    expect(readdirSync(inboxDir).filter((f) => f.endsWith('.json')).length).toBe(1)
  })
})
