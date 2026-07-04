import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const TMUX = '/usr/bin/tmux'

export interface TmuxSessionOpts {
  socket: string
  session: string
  cwd: string
  // Re-evaluated on every (re)spawn so the resume flag is recomputed from the
  // current on-disk transcript state (first boot → --session-id, respawn after
  // a transcript exists → --resume). See session-id.ts:buildClaudeCommand.
  buildCommand: () => string
  // Private dir for the 0600 secret-env file (state_dir). When set AND
  // CLAUDE_CODE_OAUTH_TOKEN is present, the token is passed via a sourced file
  // instead of an inline `TOKEN=… claude` prefix — the inline form leaks the
  // token to every local user through `ps aux` / tmux server cmdline.
  secretDir?: string
}

export interface TmuxSession {
  exists(): Promise<boolean>
  ensure(): Promise<void>
  sendKeys(text: string): Promise<void>
  sendEscape(): Promise<void>
  hardRestart(): Promise<void>
  capturePane(): Promise<string>
  kill(): Promise<void>
}

async function run(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn([TMUX, ...args], { stdout: 'pipe', stderr: 'pipe' })
  const exit = await proc.exited
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  return { ok: exit === 0, stdout, stderr }
}

export function createTmuxSession(opts: TmuxSessionOpts): TmuxSession {
  const baseArgs = ['-L', opts.socket]
  // Inject a long-lived auth token into the Claude command. tmux's session env
  // (-e) is NOT inherited by the new-session initial command, and tmux-server
  // env inheritance is fragile (the daemon caches env from its first client).
  // The old inline `TOKEN=… claude` prefix leaked the token to every local
  // user via `ps aux`, so with a secretDir we write a 0600 env file and source
  // it inside the spawned shell — only the file PATH is visible in cmdline.
  // Fallback (no secretDir): the legacy inline prefix, so nothing breaks.
  const tokenEnv = process.env.CLAUDE_CODE_OAUTH_TOKEN
  const writeSecretEnv = (): string => {
    const p = join(opts.secretDir!, 'claude-secret.env')
    writeFileSync(p, `CLAUDE_CODE_OAUTH_TOKEN=${tokenEnv}\n`, { mode: 0o600 })
    return p
  }
  const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
  const buildCmd = (): string => {
    const cmd = opts.buildCommand()
    if (!tokenEnv) return cmd
    if (!opts.secretDir) return `CLAUDE_CODE_OAUTH_TOKEN=${tokenEnv} ${cmd}`
    const envFile = writeSecretEnv()
    return `sh -c ${shQuote(`set -a; . ${envFile}; set +a; exec ${cmd}`)}`
  }
  return {
    async exists() {
      const r = await run([...baseArgs, 'has-session', '-t', opts.session])
      return r.ok
    },
    async ensure() {
      const r = await run([...baseArgs, 'has-session', '-t', opts.session])
      if (r.ok) return
      const r2 = await run([
        ...baseArgs, 'new-session', '-d', '-s', opts.session,
        '-c', opts.cwd, buildCmd(),
      ])
      if (!r2.ok) throw new Error(`tmux new-session failed: ${r2.stderr}`)
    },
    async sendKeys(text) {
      const r1 = await run([...baseArgs, 'send-keys', '-t', opts.session, '-l', text])
      if (!r1.ok) throw new Error(`tmux send-keys (text) failed: ${r1.stderr}`)
      await new Promise((resolve) => setTimeout(resolve, 150))
      const r2 = await run([...baseArgs, 'send-keys', '-t', opts.session, 'Enter'])
      if (!r2.ok) throw new Error(`tmux send-keys (Enter) failed: ${r2.stderr}`)
      // Enter-verify: while Claude is busy, the TUI sometimes swallows the
      // submit — the text stays parked in the input box and the message never
      // reaches the model (observed 4× on 2026-07-04). Detect the leftover by
      // looking for the tail of what we just typed in the pane's last lines and
      // re-press Enter. Retrying ONLY on a confirmed leftover keeps this safe:
      // no stray Enter into an empty input, a modal, or someone else's dialog.
      const tail = text.split('\n').pop()?.trim().slice(-32) ?? ''
      if (tail.length < 8) return // too short to match reliably — skip verify
      for (let attempt = 0; attempt < 2; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 600))
        let pane = ''
        try {
          const cap = await run([...baseArgs, 'capture-pane', '-t', opts.session, '-p'])
          if (!cap.ok) return
          pane = cap.stdout
        } catch {
          return
        }
        const lastLines = pane.trimEnd().split('\n').slice(-8)
        const stuck = lastLines.some((l) => l.includes('>') && l.includes(tail))
        if (!stuck) return
        await run([...baseArgs, 'send-keys', '-t', opts.session, 'Enter'])
      }
    },
    async sendEscape() {
      // Soft interrupt — only works while Claude's input loop is responsive.
      await run([...baseArgs, 'send-keys', '-t', opts.session, 'Escape'])
    },
    async hardRestart() {
      // Kill + respawn the Claude process. Used when the TUI is wedged (modal
      // stuck, input loop dead/lagged) and no keystroke can recover it. This is
      // the only reliable /new when send-keys is being ignored.
      await run([...baseArgs, 'kill-session', '-t', opts.session])
      await new Promise((resolve) => setTimeout(resolve, 300))
      const r = await run([
        ...baseArgs, 'new-session', '-d', '-s', opts.session,
        '-c', opts.cwd, buildCmd(),
      ])
      if (!r.ok) throw new Error(`tmux new-session (restart) failed: ${r.stderr}`)
    },
    async capturePane() {
      const r = await run([...baseArgs, 'capture-pane', '-t', opts.session, '-p'])
      if (!r.ok) throw new Error(`tmux capture-pane failed: ${r.stderr}`)
      return r.stdout
    },
    async kill() {
      await run([...baseArgs, 'kill-server'])
    },
  }
}
