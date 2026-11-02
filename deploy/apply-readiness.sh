#!/usr/bin/env bash
# apply-readiness.sh — заменить слепой ExecStartPost(sleep 8) на confirm-ready.sh
# во всех tg-bridge юнитах. ЗАПУСКАТЬ РУКАМИ ПОД SUDO (Александр):
#   sudo bash /home/edgelab/projects/tg-bridge-a2/deploy/apply-readiness.sh
#
# Меняет только ExecStartPost через drop-in (units не редактирует), затем
# daemon-reload. РЕСТАРТЫ НЕ ДЕЛАЕТ — новое поведение подхватится при следующем
# рестарте каждого моста.
set -euo pipefail
CONFIRM=/home/edgelab/projects/tg-bridge-a2/deploy/confirm-ready.sh
chmod +x "$CONFIRM"

declare -A AGENTS=(
  [a2meta]=a2meta
  [arthas]=arthas
  [metabolic]=metabolic
  [wife]=wife
)

for unit in "${!AGENTS[@]}"; do
  session="${AGENTS[$unit]}"
  dir="/etc/systemd/system/tg-bridge-${unit}.service.d"
  mkdir -p "$dir"
  cat > "$dir/60-readiness.conf" <<EOF
[Service]
# drop-in: заменяем слепой sleep-8-Enter на confirm-loop (apply-readiness.sh)
ExecStartPost=
ExecStartPost=$CONFIRM tgbridge-${unit} ${session}
EOF
  echo "drop-in written: $dir/60-readiness.conf"
done

systemctl daemon-reload
echo "daemon-reload done. Рестарты юнитов НЕ выполнялись — применится при следующем рестарте."
