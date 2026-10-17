#!/bin/sh
# LaunchdUnit.tla под TLC с проверкой ожиданий: основная модель (инварианты и живучесть) без
# ошибок, каждый свидетель нарушает свой инвариант первым (поиск в ширину, один поток — самый
# короткий контрпример). Любой сбой tlc или несовпадение ожидания — ненулевой выход. Файлы
# состояний TLC пишет во временную папку и удаляет её на выходе.
set -u
cd "$(dirname "$0")" || exit 2
. ./tlc-result.sh || exit 2
TLC=${TLC:-$(command -v tlc || echo "$HOME/.local/bin/tlc")}
[ -x "$TLC" ] || { echo "launchd-unit-check: tlc not found (set TLC=/path/to/tlc)"; exit 2; }
META=$(mktemp -d) || exit 2
trap 'rm -rf "$META"' EXIT
ok=0; failed=0
check() { # config expected; expected: none | <Invariant> | <Property>
  cfg=$1; expect=$2; log="$META/$cfg.log"
  cp LaunchdUnit.tla "$cfg.cfg" "$META/"
  (cd "$META" && "$TLC" -workers 1 -deadlock -metadir "$META/$cfg.states" -config "$cfg.cfg" LaunchdUnit.tla) >"$log" 2>&1
  code=$?
  if tlc_expect "$log" "$code" "$META/$cfg.cfg" "$expect"; then
    if [ "$got" = none ]; then
      echo "OK $cfg: no error ($(sed -n 's/.* \([0-9,]*\) distinct states found.*/\1/p' "$log" | tail -1) distinct states)"
    else echo "OK $cfg: $got violated (expected)"; fi
    ok=$((ok+1))
  else
    echo "FAIL $cfg: got '${got:-error}', expected '$expect'"; failed=$((failed+1))
  fi
}
check LaunchdUnit-stop-kill NoSelfStart
check LaunchdUnit-active-loaded ActiveOnlyRunning
check LaunchdUnit-oneshot-bootout CalendarKept
check LaunchdUnit-kill-unloaded QuiesceStops
check LaunchdUnit-stop-timer-kill QuiesceStops
check LaunchdUnit-throttled-inactive KeepAliveSurvivesUpdate
check LaunchdUnit-restart-kickstart RestartLoadsPlist
check LaunchdUnit-timer-restart-kickstart TimerVerbNoRun
check LaunchdUnit-restart-nowait RestartWorks
check LaunchdUnit-stop-nowait QuiesceStops
check LaunchdUnit-nokeepalive CrashRecovers
check LaunchdUnit none
echo "launchd-unit-check: $ok ok, $failed failed"
[ "$failed" -eq 0 ]
