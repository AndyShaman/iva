#!/bin/sh
# Helpers v6.1: новые контракты + регрессионные графы. BFS, последовательно, <=4 workers.
# CHECK_MODE=simulate проверяет запуск и случайные трассы, без полного BFS.
set -u
cd "$(dirname "$0")" || exit 2
ROOT=$(cd .. && pwd) || exit 2
TLC=${TLC:-$(command -v tlc || printf '%s/.local/bin/tlc' "$HOME")}
[ -x "$TLC" ] || { echo 'helper-check: tlc not found (set TLC=/path/to/tlc)'; exit 2; }
TIMEOUT=${TIMEOUT:-$(command -v timeout || command -v gtimeout || true)}
[ -x "$TIMEOUT" ] || { echo 'helper-check: GNU timeout required (set TIMEOUT=/path/to/timeout)'; exit 2; }
WORKERS=${WORKERS:-4}
case "$WORKERS" in 1|2|3|4) ;; *) echo "helper-check: WORKERS must be 1..4"; exit 2;; esac
CHECK_MODE=${CHECK_MODE:-bfs}
case "$CHECK_MODE" in bfs|simulate) ;; *) echo 'helper-check: CHECK_MODE must be bfs or simulate'; exit 2;; esac
mkdir -p "$ROOT/.scratch/helper-tla" || exit 2
META=$(mktemp -d "$ROOT/.scratch/helper-tla/check.XXXXXX") || exit 2
trap 'rm -rf "$META"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
ok=0; failed=0
wait_load() {
  command -v sysctl >/dev/null 2>&1 || return 0
  while :; do
    load=$(sysctl -n vm.loadavg 2>/dev/null | awk '{gsub(/[{}]/, ""); print $1}')
    [ -n "$load" ] || return 0
    awk -v n="$load" 'BEGIN {exit !(n < 20)}' && return 0
    echo "WAIT load=$load; need <20"
    sleep 10
  done
}
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
    set -- -fp 1 -seed "${BFS_SEED:-20261013}"
    [ "$expect" != none ] || set -- "$@" -lncheck final
  fi
  wait_load
  echo "LOAD $cfg: ${load:-unavailable}; required <20"
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
    # Для ожидаемого temporal witness cfg должен иметь ровно одно свойство.
    got=$(sed -n 's/^PROPERTY \([A-Za-z0-9_]*\)$/\1/p' "$cfg.cfg")
  fi
  states=$(sed -n 's/.* \([0-9,]*\) distinct states found.*/\1/p' "$log" | tail -1)
  checked=$(sed -n 's/^Progress: \([0-9,]*\) states checked.*/\1/p' "$log" | tail -1)
  elapsed=$(sed -n 's/^Finished in \(.*\) at .*/\1/p' "$log" | tail -1)
  if [ -n "${LOG_DIR:-}" ]; then
    mkdir -p "$LOG_DIR" || return 2
    cp "$log" "$LOG_DIR/$cfg.log" || return 2
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$cfg" "$expect" "${got:-error}" "$code" "${states:-unknown}" "${elapsed:-unknown}" "${load:-unavailable}" >> "$LOG_DIR/results.tsv"
  fi
  valid=false
  [ "$got" = none ] && [ "$code" -eq 0 ] && valid=true
  [ -n "$got" ] && [ "$got" != none ] && [ "$code" -eq 12 ] && valid=true
  [ -n "$got" ] && [ "$code" -eq 13 ] && valid=true
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
check HelperRun-v6-auth none || exit 2
check HelperRun-v6-spawn none || exit 2
check HelperRun-v6-question none || exit 2
check HelperRun-v6-owner none || exit 2
check HelperRun-v6-effects none || exit 2
check HelperRun-v6-live none || exit 2
check HelperRun-v6-helper-start V6Authorized || exit 2
check HelperRun-v6-wake-start V6Authorized || exit 2
check HelperRun-v6-wake-close V6Authorized || exit 2
check HelperRun-v6-may V6MayRequired || exit 2
check HelperRun-v6-may-copy V6MayUnchanged || exit 2
check HelperRun-v6-pid V6PidKnown || exit 2
check HelperRun-v6-owner-kill V6OwnerKillSafe || exit 2
check HelperRun-v6-question-done V6QuestionFailed || exit 2
check HelperRun-v6-early-free V6SlotFreedAfterEnd || exit 2
check HelperRun-v6-partial V6PartialKept || exit 2
check HelperRun-v6-sweep V6KeepClosed || exit 2
check HelperRun-v6-read V6ClosedReadable || exit 2
check HelperRun-v6-late-effect V6NoLateEffect || exit 2
check HelperRun-v6-duplicate-effect V6NoDuplicateEffect || exit 2
check HelperRun-v6-tail-effect V6NoTailEffect || exit 2
check HelperRun-v6-normal-waiting V6NoNormalWaiting || exit 2
check HelperRun-v6-before-pid V6NoUnrecordedCreate || exit 2
check HelperOutcome-v6-delivery none || exit 2
check HelperOutcome-v6-alert none || exit 2
check HelperOutcome-v6-pipeline none || exit 2
check HelperOutcome-v6-wake none || exit 2
check HelperOutcome-v6-wakes none || exit 2
check HelperOutcome-v6-alert-live none || exit 2
check HelperOutcome-v6-pipeline-live none || exit 2
check HelperOutcome-v6-session V6DeliveryProven || exit 2
check HelperOutcome-v6-chat V6DeliveryProven || exit 2
check HelperOutcome-v6-closed-mark V6ManualNoShown || exit 2
check HelperOutcome-v6-delivered-mark V6DeliveredReadNoWrite || exit 2
check HelperOutcome-v6-sweep V6Retention || exit 2
check HelperOutcome-v6-alert-order V6AlertConfirmed || exit 2
check HelperOutcome-v6-stamp V6WakeCounting || exit 2
check HelperOutcome-v6-wake-guard V6NoWakeWhileBusy || exit 2
check HelperOutcome-v6-wake-action V6WakeReadOnly || exit 2
check HelperOutcome-v6-bridge-mixed V6BridgeHomogeneous || exit 2
check HelperOutcome-v6-kernel-mixed V6KernelHomogeneous || exit 2
check HelperOutcome-v6-source-loss V6SourceKept || exit 2
check HelperOutcome-v6-legacy V6LegacySame || exit 2
check HelperOutcome-v6-wake-pause V6WakePause || exit 2
check HelperOutcome-v6-wake-order V6WakeEarliest || exit 2
check HelperOutcome-v6-terminal-message V6WakeNoOwnerMessage || exit 2
check HelperOutcome-v6-alert-duplicate V6NoDuplicateAlert || exit 2
check HelperOutcome-v6-close-read-second V6NoTwoReads || exit 2
check HelperRun-v6-close-outcome V6CloseKeepsOutcome || exit 2
check HelperRun-v6-close-inflight V6NoCloseInFlight || exit 2
check HelperOutcome-v6-second-finished V6OneDeliveredPerTurn || exit 2
check HelperOutcome-v6-delivered-clock V6Retention || exit 2
check HelperOutcome-v6-pipeline-race none || exit 2
check HelperOutcome-v6-pipeline-race-live none || exit 2
check HelperOutcome-v6-delivery-live none || exit 2
check HelperRun-v6-live-nofair V6NoSilentEnd || exit 2
check HelperOutcome-v6-delivery-live-nofair V6EventuallyDelivered || exit 2
check HelperOutcome-v6-alert-live-nofair V6AlertEventually || exit 2
check HelperOutcome-v6-pipeline-live-nofair V6PipelineEventually || exit 2
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
