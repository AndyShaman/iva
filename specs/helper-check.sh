#!/bin/sh
# Helpers v6.3: оставшиеся контракты и свидетели принятых последствий. BFS, <=4 workers.
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
check HelperRun-v63-auth none || exit 2
check HelperRun-v63-capacity none || exit 2
check HelperRun-v63-run none || exit 2
check HelperRun-v63-effects none || exit 2
check HelperRun-v63-live none || exit 2
check HelperRun-v63-helper-start Authorized || exit 2
check HelperRun-v63-may MayRequired || exit 2
check HelperRun-v63-may-copy MayUnchanged || exit 2
check HelperRun-v63-no-capacity OneRun || exit 2
check HelperRun-v63-finalize-twice OutcomeOnce || exit 2
check HelperRun-v63-stale-cas SlotFreedAfterEnd || exit 2
check HelperRun-v63-stop-twice StopOnce || exit 2
check HelperRun-v63-step-limit WithinLimits || exit 2
check HelperRun-v63-work-output WorkMeasured || exit 2
check HelperRun-v63-work-stop WorkStops || exit 2
check HelperRun-v63-question-done QuestionFailed || exit 2
check HelperRun-v63-early-free SlotFreedAfterEnd || exit 2
check HelperRun-v63-partial PartialKept || exit 2
check HelperRun-v63-sweep KeepClosed || exit 2
check HelperRun-v63-read ClosedReadable || exit 2
check HelperRun-v63-close-outcome CloseKeepsOutcome || exit 2
check HelperRun-v63-late-effect NoLateEffect || exit 2
check HelperRun-v63-duplicate-effect NoDuplicateEffect || exit 2
check HelperRun-v63-tail-effect NoTailEffect || exit 2
check HelperRun-v63-normal-waiting NoNormalWaiting || exit 2
check HelperRun-v63-live-nofair NoSilentEnd || exit 2
check HelperRun-v63-restart-effect NoRestartEffect || exit 2
check HelperOutcome-safety none || exit 2
check HelperOutcome-finish-twice OutcomeOnce || exit 2
check HelperOutcome-before-reply DeliveredAfterReply || exit 2
check HelperOutcome-empty-reply DeliveredAfterReply || exit 2
check HelperOutcome-without-read DeliveredAfterReply || exit 2
check HelperOutcome-turn-only DeliveredAfterReply || exit 2
check HelperOutcome-lose-unread UndeliveredKept || exit 2
check HelperOutcome-hide-unread Visible || exit 2
check HelperOutcome-early-close ClosedKept || exit 2
check HelperOutcome-read-write ReadPure || exit 2
check HelperOutcome-multiple NoTwoReads || exit 2
check HelperOutcome-restart NoRepeatedRead || exit 2
echo "helper-check: ok=$ok failed=$failed"
[ "$failed" -eq 0 ]
