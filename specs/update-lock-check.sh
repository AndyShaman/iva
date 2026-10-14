#!/bin/sh
set -eu
cd "$(dirname "$0")"
. ./tlc-result.sh || exit 2
TLC=${TLC:-$(command -v tlc)}
META=$(mktemp -d)
trap 'rm -rf "$META"' EXIT
check() {
  cfg=$1; expected=$2
  code=0
  workers=${WORKERS:-2}; [ "$expected" = none ] || workers=1
  "$TLC" -workers "$workers" -deadlock -metadir "$META/$cfg" -config "$cfg.cfg" UpdateLock.tla >"$META/$cfg.log" 2>&1 || code=$?
  tlc_expect "$META/$cfg.log" "$code" "$cfg.cfg" "$expected" || { cat "$META/$cfg.log"; exit 1; }
  echo "OK $cfg: $expected (exit $code)"
}
check UpdateLock none
check UpdateLock-mixed MutualExclusion
check UpdateLock-three MutualExclusion
check UpdateLock-by-path MutualExclusion
check UpdateLock-ownerless none
check UpdateLock-ownerless-unsafe MutualExclusion
