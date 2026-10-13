#!/bin/sh
# ButtonTap.tla под TLC с проверкой ожиданий: основная модель без ошибок, каждый свидетель
# нарушает свой инвариант первым (поиск в ширину, один поток — самый короткий контрпример).
# Любой сбой tlc или несовпадение ожидания — ненулевой выход. Файлы состояний TLC пишет во
# временную папку.
set -u
cd "$(dirname "$0")" || exit 2
TLC=${TLC:-$(command -v tlc || echo "$HOME/.local/bin/tlc")}
[ -x "$TLC" ] || { echo "button-tap-check: tlc not found (set TLC=/path/to/tlc)"; exit 2; }
META=$(mktemp -d) || exit 2
trap 'rm -rf "$META"' EXIT
ok=0; failed=0
check() { # config expected; expected: none | <Invariant>
  cfg=$1; expect=$2; log="$META/$cfg.log"
  cp ButtonTap.tla "$cfg.cfg" "$META/"
  (cd "$META" && "$TLC" -workers 1 -deadlock -metadir "$META/$cfg.states" -config "$cfg.cfg" ButtonTap.tla) >"$log" 2>&1
  if grep -q "No error has been found" "$log"; then got=none
  else got=$(sed -n 's/^Error: Invariant \([A-Za-z]*\) is violated.*/\1/p' "$log" | head -1); fi
  if [ -z "$got" ]; then
    echo "FAIL $cfg: tlc failed or gave no verdict"; sed -n '1,40p' "$log"; failed=$((failed+1)); return
  fi
  # The first bad state must have exactly two admissions. Merely finding some violation
  # also accepts a weakened <= 2 invariant, which fails only after a third admission.
  if [ "$got" = OnePerProcess ]; then
    last_admitted=$(sed -n 's/.*admitted = //p' "$log" | tail -1)
    size=$(printf '%s\n' "$last_admitted" | awk '{gsub(/[{} ]/, ""); print length($0) ? split($0, a, ",") : 0}')
    if [ "$size" -ne 2 ]; then
      echo "FAIL $cfg: OnePerProcess first fails with $size admissions, expected 2"
      failed=$((failed+1)); return
    fi
  fi
  if [ "$got" = "$expect" ]; then
    if [ "$got" = none ]; then
      echo "OK $cfg: no error ($(sed -n 's/.* \([0-9,]*\) distinct states found.*/\1/p' "$log" | tail -1) distinct states)"
    else echo "OK $cfg: $got violated (expected)"; fi
    ok=$((ok+1))
  else
    echo "FAIL $cfg: got '$got', expected '$expect'"; failed=$((failed+1))
  fi
}
check ButtonTap-keyonly NoSwallow
check ButtonTap-nomemory OnePerProcess
check ButtonTap-eviction OnePerProcess
check ButtonTap none
echo "button-tap-check: $ok ok, $failed failed"
[ "$failed" -eq 0 ]
