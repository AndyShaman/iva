#!/bin/sh
# QueueDrain.tla под TLC с проверкой ожиданий (спека .scratch/work/wave-1010/l5/spec-v2.md, раздел 7).
# Конфигурации кода спеки v2 (R1 в маршруте) — без ошибок: старт в «Очередь» и в «Перебивать» с двумя
# переключениями, потеря id ledger. Свидетели-мутанты (снятие по старому снимку, без закрепа, склейка
# разных авторов, склейка alone) и F1 (код без R1) нарушают свой инвариант первым (поиск в ширину,
# свидетель в один поток — самый короткий контрпример). Любой сбой tlc или несовпадение ожидания —
# ненулевой выход. Файлы состояний TLC пишет во временную папку.
set -u
cd "$(dirname "$0")" || exit 2
TLC=${TLC:-$(command -v tlc || echo "$HOME/.local/bin/tlc")}
[ -x "$TLC" ] || { echo "queue-drain-check: tlc not found (set TLC=/path/to/tlc)"; exit 2; }
WORKERS=${WORKERS:-2}
META=$(mktemp -d) || exit 2
trap 'rm -rf "$META"' EXIT
ok=0; failed=0
check() { # config expected; expected: none | <Invariant>
  cfg=$1; expect=$2; run="$META/$cfg"; log="$run.log"
  cp "$cfg.cfg" "$run.cfg"
  w=$WORKERS; [ "$expect" = none ] || w=1
  "$TLC" -workers "$w" -deadlock -metadir "$run.states" -config "$run.cfg" QueueDrain.tla >"$log" 2>&1
  if grep -q "No error has been found" "$log"; then got=none
  else got=$(sed -n 's/^Error: Invariant \([A-Za-z]*\) is violated.*/\1/p' "$log" | head -1); fi
  if [ -z "$got" ]; then
    echo "FAIL $cfg: tlc failed or gave no verdict"; sed -n '1,40p' "$log"; failed=$((failed+1)); return
  fi
  states=$(sed -n 's/.* \([0-9,]*\) distinct states found.*/\1/p' "$log" | tail -1)
  if [ "$got" = "$expect" ]; then
    if [ "$got" = none ]; then echo "OK $cfg: no error ($states distinct states)"
    else echo "OK $cfg: $got violated (expected)"; fi
    ok=$((ok+1))
  else
    echo "FAIL $cfg: got '$got', expected '$expect'"; failed=$((failed+1))
  fi
}
check QueueDrain-staleack NoLoss
check QueueDrain-nopin NoDupBeyondBreak
check QueueDrain-anysender NoLoss
check QueueDrain-mergealone AloneStaysAlone
check QueueDrain-switch NoLoss
check QueueDrain-switch-norestart NoLoss
check QueueDrain none
check QueueDrain-steer none
check QueueDrain-ledgerloss none
echo "queue-drain-check: $ok ok, $failed failed"
[ "$failed" -eq 0 ]
