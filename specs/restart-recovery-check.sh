#!/bin/sh
set -eu
cd "$(dirname "$0")"
TLC=${TLC:-$(command -v tlc)}
META=$(mktemp -d)
trap 'rm -rf "$META"' EXIT
check() {
  cfg=$1; expected=$2
  code=0
  "$TLC" -workers "${WORKERS:-2}" -deadlock -metadir "$META/$cfg" -config "$cfg.cfg" RestartRecovery.tla >"$META/$cfg.log" 2>&1 || code=$?
  if [ "$expected" = none ]; then
    [ "$code" -eq 0 ] && grep -q "No error has been found" "$META/$cfg.log" || { cat "$META/$cfg.log"; exit 1; }
  else
    [ "$code" -ne 0 ] && grep -q "Invariant $expected is violated" "$META/$cfg.log" || { cat "$META/$cfg.log"; exit 1; }
  fi
  echo "OK $cfg: $expected (exit $code)"
}
check RestartRecovery none
check RestartRecovery-candidate NeverBlocked
check RestartRecovery-window none
check RestartRecovery-window-unsafe ClosedStaysClosed
