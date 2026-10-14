#!/bin/sh
# Exhaustive BFS, foreground, <=600 seconds for the entire suite. At most four workers.
set -u
cd "$(dirname "$0")" || exit 2
. ./tlc-result.sh || exit 2
ROOT=$(cd .. && pwd) || exit 2
TLC=${TLC:-$(command -v tlc || printf '%s/.local/bin/tlc' "$HOME")}
TIMEOUT=${TIMEOUT:-$(command -v timeout || command -v gtimeout || true)}
[ -x "$TLC" ] && [ -x "$TIMEOUT" ] || { echo 'goal-check: tlc and GNU timeout required'; exit 2; }
mkdir -p "$ROOT/.scratch/goal-tla" || exit 2
META=$(mktemp -d "$ROOT/.scratch/goal-tla/check.XXXXXX") || exit 2
trap 'rm -rf "$META"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
WORKERS=${WORKERS:-4}
case "$WORKERS" in 1|2|3|4) ;; *) echo "goal-check: WORKERS must be 1..4"; exit 2;; esac
started=$(date +%s)
ok=0; failed=0
check() {
 cfg=$1; expect=$2; log="$META/$cfg.log"
 remaining=$((595 - $(date +%s) + started))
 [ "$remaining" -gt 0 ] || { echo 'goal-check: whole-suite deadline exceeded'; return 2; }
 duration=${TLC_TIMEOUT:-150}
 [ "$duration" -le "$remaining" ] || duration=$remaining
 echo "RUN $cfg expected=$expect workers=$WORKERS timeout=${duration}s"
 "$TIMEOUT" --foreground --kill-after=5s "${duration}s" "$TLC" -workers "$WORKERS" -deadlock \
   -lncheck final -metadir "$META/$cfg.states" -config "$cfg.cfg" GoalCheck.tla >"$log" 2>&1
 code=$?
 valid=false
 tlc_expect "$log" "$code" "$cfg.cfg" "$expect" "" "${CHECK_MODE:-bfs}" && valid=true
 states=$(sed -n 's/.* \([0-9,]*\) distinct states found.*/\1/p' "$log" | tail -1)
 generated=$(sed -n 's/^\([0-9,]*\) states generated.*/\1/p' "$log" | tail -1)
 elapsed=$(sed -n 's/^Finished in \(.*\) at .*/\1/p' "$log" | tail -1)
 trace=$(grep -c '^State [0-9]*:' "$log" || true)
 if [ -n "${LOG_DIR:-}" ]; then
   mkdir -p "$LOG_DIR" || return 2
   cp "$log" "$LOG_DIR/$cfg.log" || return 2
   printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$cfg" "$code" "${got:-error}" "${states:-unknown}" "${generated:-unknown}" "${elapsed:-unknown}" "$trace" >> "$LOG_DIR/results.tsv"
 fi
 if [ "$valid" = true ]; then
   echo "OK $cfg: $got exit=$code distinct=${states:-unknown} generated=${generated:-unknown} time=${elapsed:-unknown} trace=$trace"
   ok=$((ok+1))
 else
   echo "FAIL $cfg expected=$expect got=${got:-error} exit=$code"
   tail -20 "$log"
   failed=$((failed+1))
   return 2
 fi
}
# Corrected design must be green before any negative configuration.
check GoalCheck none || exit 2
check GoalCheck-crashes none || exit 2
check GoalCheck-owner none || exit 2
check GoalCheck-failures none || exit 2
check GoalCheck-failures-live none || exit 2
check GoalCheck-limits none || exit 2
check GoalCheck-live none || exit 2
check GoalCheck-capacity none || exit 2
check GoalCheck-day-cap none || exit 2
check GoalCheck-history none || exit 2
check GoalCheck-day none || exit 2
check GoalCheck-capacity-reach NoFullTable || exit 2
check GoalCheck-claim-rev OnlyOwnerActs || exit 2
# Rejected designs are retained as counterexamples.
check GoalCheck-fail-default OwnerNextKept || exit 2
check GoalCheck-spec-file-race LastSavedMonotone || exit 2
check GoalCheck-spec-weak-fair DueServed || exit 2
check GoalCheck-norev CancelChangesNothing || exit 2
check GoalCheck-noclosed ClosedMeansClosed || exit 2
check GoalCheck-owner-time OwnerNextKept || exit 2
check GoalCheck-doublecheck OneLiveCheck || exit 2
check GoalCheck-split CheckReleased || exit 2
check GoalCheck-pending-close CheckReleased || exit 2
check GoalCheck-require-done ContentReportTold || exit 2
check GoalCheck-quiet-empty FailureCount || exit 2
check GoalCheck-content-failure FailureCount || exit 2
check GoalCheck-sweep-unsaved NoSweepBeforeSaved || exit 2
check GoalCheck-no-compare LastSavedMonotone || exit 2
check GoalCheck-notice-untold OneUntoldPerGoal || exit 2
check GoalCheck-edit-owes NoStaleNotice || exit 2
check GoalCheck-close-untold ClosedMeansClosed || exit 2
check GoalCheck-nonormalize DueServed || exit 2
printf 'goal-check: %s ok, %s failed; elapsed=%ss\n' "$ok" "$failed" "$(($(date +%s)-started))"
[ "$failed" -eq 0 ]
