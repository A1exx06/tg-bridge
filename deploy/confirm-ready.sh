#!/usr/bin/env bash
# confirm-ready.sh <tmux-socket> <tmux-session> — readiness-гейт для ExecStartPost.
#
# Заменяет слепой «sleep 8 && send-keys Enter»: на холодном старте welcome/trust
# промпт Claude Code может отрисоваться позже 8 секунд — слепой Enter уходит в
# пустоту, systemd считает юнит готовым, а сессия так и не поднялась (идея
# подтверждена в проде dashi-plugin, раздел Readiness).
#
# Логика: до 90 секунд опрашиваем pane каждые 3с;
#   - видим trust/confirm-промпт → жмём Enter (по факту, не по таймеру);
#   - видим живой TUI Claude (строка ввода) → exit 0 (юнит реально готов);
#   - 90с без признаков жизни → exit 1 (systemd покажет failed, Restart подхватит).
set -u
SOCKET="${1:?usage: confirm-ready.sh <socket> <session>}"
SESSION="${2:?usage: confirm-ready.sh <socket> <session>}"
TMUX=/usr/bin/tmux

for _ in $(seq 1 30); do
  pane="$($TMUX -L "$SOCKET" capture-pane -pt "$SESSION" 2>/dev/null || true)"
  if printf '%s' "$pane" | grep -qE 'Do you trust|Enter to confirm|I am using this for local development'; then
    $TMUX -L "$SOCKET" send-keys -t "$SESSION" Enter 2>/dev/null || true
  elif printf '%s' "$pane" | grep -qE '^\s*(╭|│)?\s*>' ; then
    exit 0
  fi
  sleep 3
done
exit 1
