#!/bin/sh
# Helpers v4.4: OneDeliveredPerTurn, multipart Outbox. SPEC-FIX-3 отклонён. BFS по умолчанию, последовательно.
# CHECK_MODE=simulate проверяет запуск и случайные трассы, без полного BFS.
set -u
cd "$(dirname "$0")" || exit 2
ROOT=$(cd .. && pwd) || exit 2
TLC=${TLC:-$(command -v tlc || printf '%s/.local/bin/tlc' "$HOME")}
[ -x "$TLC" ] || { echo 'helper-check: tlc not found (set TLC=/path/to/tlc)'; exit 2; }
TIMEOUT=${TIMEOUT:-$(command -v timeout || command -v gtimeout || true)}
[ -x "$TIMEOUT" ] || { echo 'helper-check: GNU timeout required (set TIMEOUT=/path/to/timeout)'; exit 2; }
WORKERS=${WORKERS:-8}
CHECK_MODE=${CHECK_MODE:-bfs}
case "$CHECK_MODE" in bfs|simulate) ;; *) echo 'helper-check: CHECK_MODE must be bfs or simulate'; exit 2;; esac
mkdir -p "$ROOT/.scratch/helper-tla" || exit 2
META=$(mktemp -d "$ROOT/.scratch/helper-tla/check.XXXXXX") || exit 2
trap 'rm -rf "$META"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
ok=0; failed=0
check() {
  cfg=$1; expect=$2; module=${cfg%%-*}; log="$META/$cfg.log"
  workers=$WORKERS; [ "$expect" = none ] || workers=1
  echo "RUN $cfg: expected=$expect; mode=$CHECK_MODE; workers=$workers; timeout=${TLC_TIMEOUT:-600}s"
  # В переднем плане. timeout ограничивает каждый Java-процесс, TERM -> KILL через 5s.
  # -deadlock отключает проверку тупика: конечные replay заканчиваются stutter.
  if [ "$CHECK_MODE" = simulate ]; then
    set -- -simulate "num=${SIM_TRACES:-1000}" -depth "${SIM_DEPTH:-100}" -seed "${SIM_SEED:-20261011}"
  else
    # Check temporal properties once after BFS, rather than repeatedly on partial graphs.
    set --
    [ "$expect" != none ] || set -- -lncheck final
  fi
  "$TIMEOUT" --foreground --kill-after=5s "${TLC_TIMEOUT:-600}s" "$TLC" "$@" \
    -workers "$workers" -deadlock -metadir "$META/$cfg.states" \
    -config "$cfg.cfg" "$module.tla" >"$log" 2>&1
  code=$?
  got=$(sed -n 's/^Error: Invariant \([A-Za-z0-9_]*\) is violated.*/\1/p' "$log" | head -1)
  if [ "$code" -eq 0 ] && ! grep -q '^Error:' "$log"; then
    if grep -q '^Model checking completed. No error has been found.' "$log"; then
      got=none
    elif [ "$CHECK_MODE" = simulate ] && grep -q '^Progress: .* states checked.' "$log" && grep -q '^Finished in ' "$log"; then
      got=none
    fi
  elif [ "$code" -eq 13 ] && grep -q '^Error: Temporal properties were violated' "$log"; then
    # -noreap содержит ровно одно свойство; temporal failure однозначен.
    got=$(sed -n 's/^PROPERTY \([A-Za-z0-9_]*\)$/\1/p' "$cfg.cfg")
  fi
  states=$(sed -n 's/.* \([0-9,]*\) distinct states found.*/\1/p' "$log" | tail -1)
  checked=$(sed -n 's/^Progress: \([0-9,]*\) states checked.*/\1/p' "$log" | tail -1)
  elapsed=$(sed -n 's/^Finished in \(.*\) at .*/\1/p' "$log" | tail -1)
  if [ -n "${LOG_DIR:-}" ]; then
    mkdir -p "$LOG_DIR" || return 2
    cp "$log" "$LOG_DIR/$cfg.log" || return 2
  fi
  valid=false
  [ "$got" = none ] && [ "$code" -eq 0 ] && valid=true
  [ -n "$got" ] && [ "$got" != none ] && [ "$code" -eq 12 ] && valid=true
  [ "$got" = NoSilentEnd ] && [ "$code" -eq 13 ] && valid=true
  if [ "$got" = "$expect" ] && [ "$valid" = true ]; then
    echo "OK $cfg: $got; mode=$CHECK_MODE; exit=$code; distinct=${states:-unknown}; checked=${checked:-unknown}; time=${elapsed:-unknown}"
    ok=$((ok+1))
  else
    echo "FAIL $cfg: expected=$expect; got=${got:-infrastructure/error}; mode=$CHECK_MODE; exit=$code"
    sed -n '1,30p' "$log"
    failed=$((failed+1))
    [ -n "$got" ] || return 2
  fi
}
check HelperRun-live none || exit 2
check HelperOutcome-live none || exit 2
check HelperOutcome-live-new none || exit 2
check HelperRun none || exit 2
check HelperOutcome none || exit 2
check HelperRun-pressure none || exit 2
check HelperRun-pressure-reach NoThreeRemoteTurns || exit 2
check HelperOutcome-oldcounter none || exit 2
check HelperOutcome-close-sweep none || exit 2
check HelperOutcome-multipart none || exit 2
check HelperOutcome-multipart-reach NoMultipartCompletion || exit 2
check HelperRun-nofinalize OutcomeOnce || exit 2
check HelperRun-noreap NoSilentEnd || exit 2
check HelperRun-ownerme OneRun || exit 2
check HelperRun-nolimit WithinLimits || exit 2
check HelperRun-earlyfree SlotFreedAfterEnd || exit 2
check HelperOutcome-busy NoWakeWhileBusy || exit 2
check HelperOutcome-arithmetic WakeIdUnique || exit 2
check HelperOutcome-noshown DeliveredOnlyAfterShownAndOutbox || exit 2
check HelperOutcome-nostampcas WakesCountedOnce || exit 2
check HelperOutcome-dropundelivered UndeliveredKept || exit 2
check HelperRun-spec-v43 SlotFreedAfterEnd || exit 2
check HelperOutcome-spec-v43 OneOutcomePerTurn || exit 2
# Исторический диагностический свидетель: отклонено, гарантия — OneDeliveredPerTurn.
check HelperOutcome-spec-v44 OneOutcomePerTurn || exit 2
check HelperRun-unrecorded NoUnrecordedTail || exit 2
check HelperRun-bothwriters NoBothWriters || exit 2
check HelperRun-serveronly NoServerOnly || exit 2
printf 'helper-check: %s ok, %s failed; mode=%s\n' "$ok" "$failed" "$CHECK_MODE"
[ "$failed" -eq 0 ]
