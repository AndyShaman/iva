#!/bin/sh
# Goal v3.5.1: exhaustive BFS, foreground, <=600 seconds. At most four workers.
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
 cfg=$1; expect=$2
 case " $selected " in
   ' all '|*" $cfg "*) ;;
   *) return 0;;
 esac
 log="$META/$cfg.log"
 remaining=$((595 - $(date +%s) + started))
 [ "$remaining" -gt 0 ] || { echo 'goal-check: whole-suite deadline exceeded'; return 2; }
 duration=${TLC_TIMEOUT:-150}
 [ "$duration" -le "$remaining" ] || duration=$remaining
 echo "RUN $cfg expected=$expect workers=$WORKERS timeout=${duration}s"
 mkdir -p "$META/$cfg.java" || return 2
 JAVA_TOOL_OPTIONS="${JAVA_TOOL_OPTIONS:--Xmx2g} -Djava.io.tmpdir=$META/$cfg.java" \
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
# A selected development run still goes through the same verdict/deadline checks.
# With GOAL_CONFIGS unset, every green design precedes every negative witness.
selected=${GOAL_CONFIGS:-all}
check GoalCheck none || exit 2
check GoalCheck-owner none || exit 2
check GoalCheck-failures none || exit 2
check GoalCheck-failures-live none || exit 2
check GoalCheck-limits none || exit 2
check GoalCheck-live none || exit 2
check GoalCheck-capacity none || exit 2
check GoalCheck-day none || exit 2
check GoalCheck-zombie none || exit 2
check GoalCheck-nodetach DetachedChangesNothing || exit 2
check GoalCheck-noclosed RemovedMeansSilent || exit 2
check GoalCheck-owner-time OwnerNextKept || exit 2
check GoalCheck-fail-default OwnerNextKept || exit 2
check GoalCheck-doublecheck OneLiveCheck || exit 2
check GoalCheck-pending-close CheckReleased || exit 2
check GoalCheck-require-done ContentTold || exit 2
check GoalCheck-quiet-empty FailureCount || exit 2
check GoalCheck-content-failure FailureCount || exit 2
check GoalCheck-due-untold OneUntoldPerGoal || exit 2
check GoalCheck-verdict-cas-goal VerdictOwnCheck || exit 2
check GoalCheck-no-reserve OwnerPlace || exit 2
check GoalCheck-link-stop StoreLinks || exit 2
check GoalCheck-sweep-untold UntoldKept || exit 2
check GoalCheck-claim-detached OneLiveCheck || exit 2
check GoalCheck-nonormalize DueServed || exit 2
check GoalCheck-spec-weak-fair DueServed || exit 2
check GoalCheck-capacity-reach RowsBoundedReach || exit 2
[ "$ok" -gt 0 ] || { echo 'goal-check: no configuration selected'; exit 2; }
if [ "$selected" != all ]; then
 wanted=0
 for cfg in $selected; do wanted=$((wanted+1)); done
 [ "$ok" -eq "$wanted" ] || { echo 'goal-check: unknown or duplicate configuration'; exit 2; }
fi
printf 'goal-check: %s ok, %s failed; elapsed=%ss\n' "$ok" "$failed" "$(($(date +%s)-started))"
[ "$failed" -eq 0 ]
