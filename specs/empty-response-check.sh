#!/bin/sh
set -u
cd "$(dirname "$0")" || exit 2
. ./tlc-result.sh || exit 2
TLC=${TLC:-$(command -v tlc || echo "$HOME/.local/bin/tlc")}
META=$(mktemp -d) || exit 2
trap 'rm -rf "$META"' EXIT
check() {
  cfg=$1; expected=$2
  "$TLC" -workers 1 -deadlock -metadir "$META/$cfg.states" -config "$cfg.cfg" EmptyResponse.tla >"$META/$cfg.log" 2>&1
  code=$?
  if tlc_expect "$META/$cfg.log" "$code" "$cfg.cfg" "$expected"; then
    echo "OK $cfg: $got"
  else cat "$META/$cfg.log"; return 1; fi
}
check EmptyResponse none &&
check EmptyResponse-conversation none &&
check EmptyResponse-guarded none &&
check EmptyResponse-fail-task TaskNotice &&
check EmptyResponse-unbounded Bounded
