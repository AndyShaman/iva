#!/bin/sh
set -eu
cd "$(dirname "$0")"
. ./tlc-result.sh
TLC=${TLC:-$(command -v tlc)}
META=$(mktemp -d)
trap 'rm -rf "$META"' EXIT
for config in DeferredRestart DeferredRestart-unsafe DeferredRestart-overwrite DeferredRestart-input DeferredRestart-chat-only; do
  expected=none
  case "$config" in *-unsafe|*-chat-only) expected=OnlyIdle;; *-overwrite) expected=DurableAll;; *-input) expected=InputAvailable;; esac
  code=0
  "$TLC" -workers 1 -deadlock -metadir "$META/$config" -config "$config.cfg" DeferredRestart.tla >"$META/$config.log" 2>&1 || code=$?
  tlc_expect "$META/$config.log" "$code" "$config.cfg" "$expected" || { cat "$META/$config.log"; exit 1; }
  echo "OK $config: $expected (exit $code)"
done
