#!/usr/bin/env bash
# chat-entrypoint.sh — tmux session entrypoint for the inbox-channel input
# path (feature/inbox-channel, plan B, 2026-07-04).
#
# Ported and adapted from dashi-plugin's multichat-entrypoint.sh. Our bridge
# is single-chat per session (multichat is a later stage), and our reply
# path already leaves the pane via the Stop hook, so this script only owns
# the INPUT side: it replaces the server's external `tmux send-keys` with an
# in-session watcher that consumes persisted inbox JSON and injects it
# reliably.
#
# Why this beats external send-keys (the grabli we are killing):
#   1. Persistence — the message lives in inbox/*.json (atomic rename) until
#      submit is confirmed; a swallowed Enter never loses it.
#   2. In-session inject — the watcher runs inside the pane (PANE=$TMUX_PANE),
#      not from a racing outside process.
#   3. Readiness gate — waits for the composer `❯` before the first inject,
#      so a message can't land while the TUI is still booting.
#   4. Bracketed paste — the body is one atomic paste event; the later Enter
#      can never be grouped into it as a soft newline.
#   5. Enter-only verify loop — retries ONLY Enter (never the body), so a
#      false "not submitted" reading can never duplicate the message.
#
# Env contract (fail-safe):
#   CHAT_INBOX_DIR   (required) directory the server writes *.json into.
#                    Missing -> exit 2 (refuse to start; never run a stray
#                    claude with no inbox isolation).
#   "$@"             (required) the claude launch command + args to exec in
#                    the foreground (our session-id/--resume flags). The
#                    OAuth token is already in the environment (the caller
#                    sources the 0600 secret env before exec'ing us). No
#                    args -> exit 2.
#   TMUX_PANE        set by tmux inside every pane. Missing -> watcher self-
#                    disables but claude still launches so we can attach.

set -euo pipefail

# ───── Tunables (env-overridable; tests set tiny values) ─────
READY_POLL_INTERVAL="${CHAT_READY_POLL_INTERVAL:-0.5}"
READY_POLL_MAX="${CHAT_READY_POLL_MAX:-60}"
PASTE_SETTLE="${CHAT_PASTE_SETTLE:-0.6}"
SUBMIT_RETRY_DELAY="${CHAT_SUBMIT_RETRY_DELAY:-0.4}"
SUBMIT_RETRY_FACTOR="${CHAT_SUBMIT_RETRY_FACTOR:-1.8}"
SUBMIT_RETRY_MAX="${CHAT_SUBMIT_RETRY_MAX:-5}"
# Busy gate (2026-09-01): never paste while claude is generating or compacting.
# A paste into a running turn is only queued in the composer (fingerprint
# stays visible -> false "not confirmed"), and a paste into a compaction /
# bootstrap frame is silently lost. So we wait for an idle composer first.
BUSY_POLL_INTERVAL="${CHAT_BUSY_POLL_INTERVAL:-2}"
BUSY_WAIT_MAX="${CHAT_BUSY_WAIT_MAX:-3600}"
BUSY_PATTERN="${CHAT_BUSY_PATTERN:-esc to interrupt|Compacting conversation|Bootstrapping}"

# ───── Injection helpers (PANE is a global set by the watcher subshell) ─────

# Plain-text snapshot of the VISIBLE pane only. -p strips attributes, -J
# rejoins wrapped lines. No -S: Claude Code's TUI scrolls without an
# alternate screen, so history holds stale frames; the composer always
# sits in the visible region.
pane_text() {
  tmux capture-pane -t "$PANE" -p -J 2>/dev/null || true
}

# Block until the Claude Code composer accepts input. It renders a `❯`
# prompt once the input handler is mounted; the boot banner has none. On
# timeout we proceed anyway (degrade to fixed-sleep, never drop the message).
wait_claude_ready() {
  local i
  for ((i = 0; i < READY_POLL_MAX; i++)); do
    if pane_text | grep -q '❯'; then
      sleep "$READY_POLL_INTERVAL"
      return 0
    fi
    sleep "$READY_POLL_INTERVAL"
  done
  echo "chat-entrypoint(watcher): TUI readiness timeout, injecting anyway" >&2
  return 0
}

# Block while the TUI is busy (generating / compacting / bootstrapping).
# Returns 0 when idle; on timeout logs and returns 0 (degrade to inject
# anyway — the message must never be dropped by the gate itself).
wait_claude_idle() {
  local waited=0
  while pane_text | grep -qiE "$BUSY_PATTERN"; do
    if (( waited >= BUSY_WAIT_MAX )); then
      echo "chat-entrypoint(watcher): busy-wait timeout after ${waited}s, injecting anyway" >&2
      return 0
    fi
    sleep "$BUSY_POLL_INTERVAL"
    waited=$(( waited + ${BUSY_POLL_INTERVAL%.*} ))
  done
  return 0
}

# A distinctive substring of the prompt to judge "still in the composer".
# python3 keeps the 60-char truncation UTF-8-safe (byte cut -c would split
# multibyte Russian text into a pattern that can never match the pane).
prompt_fingerprint() {
  printf '%s' "$1" | python3 -c '
import sys
lines = [l.strip() for l in sys.stdin.read().splitlines()]
for line in lines:
    if len(line) >= 8:
        sys.stdout.write(line[:60])
        break
' || true
}

# Paste the body once, then press Enter until the turn provably started.
# Success signals: footer shows "esc to interrupt" (and generation was NOT
# already running before our paste), OR the fingerprint vanished (composer
# cleared). Body is pasted once; only Enter is retried -> no duplication.
submit_prompt() {
  local msg_text="$1"
  local fp attempt delay buf out pre_generating
  fp="$(prompt_fingerprint "$msg_text")"

  wait_claude_ready
  wait_claude_idle

  pre_generating=0
  if pane_text | grep -qiE 'esc to interrupt'; then
    pre_generating=1
  fi

  buf="chat-$$"
  printf '%s' "$msg_text" | tmux load-buffer -b "$buf" - || {
    echo "chat-entrypoint(watcher): load-buffer failed" >&2
    return 1
  }
  tmux paste-buffer -d -t "$PANE" -b "$buf" -p || {
    echo "chat-entrypoint(watcher): paste-buffer failed" >&2
    return 1
  }

  sleep "$PASTE_SETTLE"

  delay="$SUBMIT_RETRY_DELAY"
  for ((attempt = 1; attempt <= SUBMIT_RETRY_MAX; attempt++)); do
    tmux send-keys -t "$PANE" Enter || true
    sleep "$delay"

    out="$(pane_text)"
    if [[ "$pre_generating" == "0" ]] && grep -qiE 'esc to interrupt' <<<"$out"; then
      return 0
    fi
    if [[ -n "$fp" ]] && ! grep -qF -- "$fp" <<<"$out"; then
      return 0
    fi
    if [[ -z "$fp" ]]; then
      return 0
    fi
    delay="$(awk -v d="$delay" -v f="$SUBMIT_RETRY_FACTOR" 'BEGIN { printf "%.2f", d * f }')"
  done

  echo "chat-entrypoint(watcher): submit not confirmed after ${SUBMIT_RETRY_MAX} attempts" >&2
  return 1
}

# Parse one JSON file into a prompt string. Reads the path from $INBOX_FILE
# so nothing user-controlled is interpolated into shell. Exit: 0 = prompt on
# stdout; 1 = parse failure; 3 = nothing to deliver (caller must NOT submit).
build_prompt() {
  INBOX_FILE="$1" python3 - <<'PYEOF'
import json
import os
import sys

path = os.environ.get('INBOX_FILE', '')
try:
    with open(path, 'r', encoding='utf-8') as f:
        d = json.load(f)
except Exception as e:  # noqa: BLE001
    print(f'chat-entrypoint(watcher): parse failed for {path}: {e}', file=sys.stderr)
    sys.exit(1)

if not isinstance(d, dict):
    print(f'chat-entrypoint(watcher): {path} is not a JSON object', file=sys.stderr)
    sys.exit(1)

text = (d.get('text', '') or '')
reply_context = d.get('reply_context')
reply_context = reply_context.strip() if isinstance(reply_context, str) else None
if reply_context == '':
    reply_context = None

raw_paths = d.get('media_paths') or []
media_paths = [p for p in raw_paths if isinstance(p, str) and p] if isinstance(raw_paths, list) else []

if not text.strip() and reply_context is None and not media_paths:
    sys.exit(3)

parts = []
if reply_context is not None:
    parts.append(reply_context)
if text:
    parts.append(text)
for p in media_paths:
    parts.append(f'[media: {p}]')
sys.stdout.write('\n\n'.join(parts))
PYEOF
}

# Drain every committed *.json in inbox/ (sorted = ms-time order). We do not
# recurse into .processed/ (find -maxdepth 1 + the *.json glob).
process_inbox() {
  local f msg_text rc
  while IFS= read -r -d '' f; do
    [[ -f "$f" ]] || continue
    rc=0
    msg_text="$(build_prompt "$f")" || rc=$?
    if [[ "$rc" -eq 3 ]]; then
      mv "$f" "${PROCESSED}/skipped-empty-$(basename "$f")"
    elif [[ "$rc" -eq 0 && -n "$msg_text" ]]; then
      if submit_prompt "$msg_text"; then
        mv "$f" "${PROCESSED}/$(basename "$f")"
      else
        mv "$f" "${PROCESSED}/submit-unconfirmed-$(basename "$f")"
      fi
    else
      mv "$f" "${PROCESSED}/parse-failed-$(basename "$f")"
    fi
  done < <(find "$INBOX" -maxdepth 1 -name '*.json' -print0 | sort -z)
}

# ───── Test seam ─────
# Sourced with CHAT_ENTRYPOINT_TEST_ONLY=1: define helpers and stop (no env
# validation, no watcher, no exec). Lets tests drive submit_prompt /
# process_inbox against a stub tmux on PATH.
if [[ "${CHAT_ENTRYPOINT_TEST_ONLY:-}" == "1" ]]; then
  return 0 2>/dev/null || exit 0
fi

# ───── Required env (fail-safe) ─────
if [[ -z "${CHAT_INBOX_DIR:-}" || "$#" -eq 0 ]]; then
  echo "chat-entrypoint: CHAT_INBOX_DIR unset or no claude command given, refusing to start" >&2
  exit 2
fi

INBOX="${CHAT_INBOX_DIR}"
PROCESSED="${INBOX}/.processed"
mkdir -p "$INBOX" "$PROCESSED"

# Placed ABOVE the watcher on purpose (a2meta, 08.09.2026): the watcher
# subshell below is forked from THIS process, so unsetting after it would
# leave the token in the watcher's own environment and in anything it runs.
# The agent process must NOT inherit the bridge's own Telegram bot token
# (08.09.2026, Alexander's word). systemd gives us TELEGRAM_BOT_TOKEN via the
# channel's EnvironmentFile because src/config.ts needs it — but that is the
# BRIDGE's need, and the bun server reads it in its own process. Everything
# below this line inherits our env: claude, its shells, every codex leg and
# every pytest run. Two ways that bites, both measured on this box:
#   * `docker compose` interpolates a shell variable OVER the project's own
#     .env, so a2route's containers would be handed the CHAT bot's token
#     instead of their own;
#   * a backend test that reads TELEGRAM_BOT_TOKEN from the environment sends
#     real messages to real people through the owner's own chat bot.
# Consumers that legitimately need the token (status-report-15m.sh,
# idle-guard.sh, a2meta-probe.ts, a2meta-token-swap.sh,
# check_agent_grant_expiry.py) all read it from a FILE, not from the
# environment, so nothing downstream breaks by unsetting it here.
unset TELEGRAM_BOT_TOKEN

# ───── Background inbox watcher ─────
(
  # Watcher diagnostics go to a log, not to the pane: anything printed into
  # the pane lands on top of the composer and reads like typed input.
  exec 2>>"${CHAT_WATCHER_LOG:-${INBOX}/watcher.log}"
  PANE="${TMUX_PANE:-}"
  if [[ -z "$PANE" ]]; then
    echo "chat-entrypoint(watcher): TMUX_PANE not set, watcher disabled" >&2
    exit 0
  fi

  # Initial drain catches messages that arrived between writeToInbox() and
  # our exec. submit_prompt's readiness gate handles the boot race.
  process_inbox

  # $$ inside the subshell is the original entrypoint PID (= claude after
  # the exec below); when it dies we exit, so a leaked watcher can't keep
  # moving inbox files meant for the next spawn.
  parent_alive() { kill -0 "$$" 2>/dev/null; }

  if command -v inotifywait >/dev/null 2>&1; then
    while parent_alive \
        && inotifywait -q -e create,moved_to --include '\.json$' "$INBOX" >/dev/null 2>&1; do
      sleep 0.1
      parent_alive || exit 0
      process_inbox
    done
  else
    while parent_alive; do
      sleep 0.5
      process_inbox
    done
  fi
) &
WATCHER_PID=$!

cleanup() {
  if kill -0 "$WATCHER_PID" 2>/dev/null; then
    kill "$WATCHER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# Hand the pane over to our claude command. exec keeps claude as the leaf
# process so tmux remain-on-exit semantics work. "$@" carries our claude
# binary + session-id/--resume flags; the OAuth token is already in env
# (the caller sourced the 0600 secret env before exec'ing this script).
exec "$@"
