#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$repo_root"
[[ -z "$(git status --porcelain --untracked-files=all)" ]] || { echo 'Commit changes before preparing eve.' >&2; exit 1; }
version="0.51.1-iva.1"
output_dir="${1:-.eve-out/release}"
mkdir -p "$output_dir"
output_dir="$(cd "$output_dir" && pwd -P)"
archive="$output_dir/eve-$version.tgz"
if [[ -f "$archive" ]]; then
  echo "Reusing $archive; this version will not be rebuilt."
else
  bash scripts/build-eve.sh "$output_dir"
fi
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
tar -xzf "$archive" -C "$stage"
source_hash="$(node scripts/lib/eve-tree-hash.ts source eve)"
packed_hash="$(node scripts/lib/eve-tree-hash.ts packed "$stage/package")"
url="https://github.com/smixs/iva-agent/releases/download/eve-$version/eve-$version.tgz"
node --input-type=module - "$archive" "$stage/package" "$version" "$url" "$source_hash" "$packed_hash" <<'JS'
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
const [archive, root, version, url, sourceHash, packedHash] = process.argv.slice(2);
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const build = json(`${root}/BUILD.json`), eve = json(`${root}/package.json`);
assert.equal(build.sourceTreeHash, sourceHash, 'Existing archive is stale: choose a new version.');
assert.equal(build.packedTreeHash, packedHash, 'Archive contents differ from BUILD.json.');
assert.equal(build.packageVersion, version);
assert.equal(eve.version, version);
const integrity = 'sha512-' + createHash('sha512').update(readFileSync(archive)).digest('base64');
const pkg = json('package.json'), lock = json('package-lock.json');
pkg.dependencies.eve = url;
lock.packages[''].dependencies.eve = url;
const entry = lock.packages['node_modules/eve'];
entry.version = version; entry.resolved = url; entry.integrity = integrity;
for (const file of ['package.json', 'package-lock.json'])
  writeFileSync(file, JSON.stringify(file === 'package.json' ? pkg : lock, null, 2) + '\n');
console.log(`Archive: ${archive}\nURL: ${url}\nIntegrity: ${integrity}`);
JS
cat <<STEPS
Remaining publication steps (maintainer):
1. Commit package.json and package-lock.json locally.
2. Create eve-$version on that commit and push only that tag.
3. Create the GitHub release and upload $archive; published tags and assets are immutable.
4. Download $url and verify its sha512 SRI against package-lock.json.
5. Run npm ci in a clean tree using the final URL.
6. Only after those checks, push the commit to beta.
STEPS
