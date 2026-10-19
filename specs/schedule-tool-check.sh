#!/bin/sh
set -eu
cd "$(dirname "$0")"
. ./tlc-result.sh
mkdir -p ../.scratch/schedule-tool
meta=$(mktemp -d ../.scratch/schedule-tool/tlc.XXXXXX)
trap 'rm -rf "$meta"' EXIT
for config in ScheduleTool ScheduleTool-mutant ScheduleTool-overlap; do
  expected=none
  case "$config" in ScheduleTool-mutant) expected=OncePerRequest;; ScheduleTool-overlap) expected=OneRunning;; esac
  code=0
  "${TLC:-$HOME/.local/bin/tlc}" -workers 1 -deadlock -metadir "$meta/$config" -config "$config.cfg" ScheduleTool.tla >"$meta/$config.log" 2>&1 || code=$?
  tlc_expect "$meta/$config.log" "$code" "$config.cfg" "$expected" "" bfs
  echo "$config: $expected (exit $code)"
done
