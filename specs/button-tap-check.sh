#!/bin/sh
# ButtonTap.tla под TLC с проверкой ожиданий: основная модель без ошибок, каждый свидетель
# нарушает свой инвариант первым (поиск в ширину, один поток — самый короткий контрпример).
# Любой сбой tlc или несовпадение ожидания — ненулевой выход. Файлы состояний TLC пишет во
# временную папку.
set -u
cd "$(dirname "$0")" || exit 2
. ./tlc-result.sh || exit 2
TLC=${TLC:-$(command -v tlc || echo "$HOME/.local/bin/tlc")}
[ -x "$TLC" ] || { echo "button-tap-check: tlc not found (set TLC=/path/to/tlc)"; exit 2; }
META=$(mktemp -d) || exit 2
trap 'rm -rf "$META"' EXIT
ok=0; failed=0
check() { # config expected; expected: none | <Invariant>
  cfg=$1; expect=$2; log="$META/$cfg.log"
  cp ButtonTap.tla "$cfg.cfg" "$META/"
  (cd "$META" && "$TLC" -workers 1 -deadlock -metadir "$META/$cfg.states" -config "$cfg.cfg" ButtonTap.tla) >"$log" 2>&1
  code=$?
  admissions=; [ "$expect" != OnePerProcess ] || admissions=2
  valid=false
  tlc_expect "$log" "$code" "$cfg.cfg" "$expect" "$admissions" && valid=true
  if [ "$valid" = true ]; then
    if [ "$got" = none ]; then
      echo "OK $cfg: no error ($(sed -n 's/.* \([0-9,]*\) distinct states found.*/\1/p' "$log" | tail -1) distinct states)"
    else echo "OK $cfg: $got violated (expected)"; fi
    ok=$((ok+1))
  else
    echo "FAIL $cfg: got '${got:-error}', expected '$expect'"; failed=$((failed+1))
  fi
}
check ButtonTap-keyonly NoSwallow
check ButtonTap-nomemory OnePerProcess
check ButtonTap-eviction OnePerProcess
check ButtonTap none
echo "button-tap-check: $ok ok, $failed failed"
[ "$failed" -eq 0 ]
