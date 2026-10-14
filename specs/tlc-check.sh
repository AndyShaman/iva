#!/bin/sh
# Малые конфиги FileLock под TLC с проверкой ожиданий: witness обязан нарушать NotSlow,
# lag/hold/sync-slow — MutualExclusion (границы контракта), остальные — без ошибок.
# Любой сбой tlc или несовпадение ожидания — ненулевой выход. 3-процессные конфиги
# (FileLock.cfg, FileLock-slow.cfg) сюда не входят: минуты и десятки миллионов состояний.
set -u
cd "$(dirname "$0")" || exit 2
. ./tlc-result.sh || exit 2
TLC=${TLC:-$(command -v tlc || echo "$HOME/.local/bin/tlc")}
[ -x "$TLC" ] || { echo "tlc-check: tlc not found (set TLC=/path/to/tlc)"; exit 2; }
WORKERS=${WORKERS:-4}
case "$WORKERS" in 1|2|3|4) ;; *) echo "WORKERS must be 1..4"; exit 2;; esac
META=$(mktemp -d) || exit 2
trap 'rm -rf "$META"' EXIT
ok=0; failed=0
check() { # config expected: none | <Invariant>
  cfg=$1; expect=$2; log="$META/$cfg.log"
  "$TLC" -workers "$WORKERS" -deadlock -metadir "$META/$cfg" -config "$cfg.cfg" FileLock.tla >"$log" 2>&1
  code=$?
  valid=false
  tlc_expect "$log" "$code" "$cfg.cfg" "$expect" "" && valid=true
  if [ "$valid" = true ]; then
    if [ "$got" = none ]; then echo "OK $cfg: no error"; else echo "OK $cfg: $got violated (expected)"; fi
    ok=$((ok+1))
  else
    echo "FAIL $cfg: got '${got:-error}', expected '$expect'"; failed=$((failed+1))
  fi
}
check FileLock-2p none
check FileLock-deadline none
check FileLock-witness NotSlow
check FileLock-lag MutualExclusion
check FileLock-hold MutualExclusion
check FileLock-sync-slow MutualExclusion
echo "tlc-check: $ok ok, $failed failed"
[ "$failed" -eq 0 ]
