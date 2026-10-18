#!/bin/sh
set -eu
cd "$(dirname "$0")"
. ./tlc-result.sh
TLC=${TLC:-$(command -v tlc)}
META=$(mktemp -d)
trap 'rm -rf "$META"' EXIT
check() {
  cfg=$1; expected=$2; code=0
  "$TLC" -workers 1 -deadlock -metadir "$META/$cfg" -config "$cfg.cfg" FirstInstall.tla >"$META/$cfg.log" 2>&1 || code=$?
  tlc_expect "$META/$cfg.log" "$code" "$cfg.cfg" "$expected" || { cat "$META/$cfg.log"; exit 1; }
  echo "OK $cfg: $expected (exit $code)"
}
check FirstInstall none
check FirstInstall-env-unsafe CompletedBeforeUpdate
check FirstInstall-release-unsafe SetupOwnsLock
check FirstInstall-clone-unsafe SafeDestination
check FirstInstall-refuse-witness RefusedOccupied
