# Building and publishing eve

Iva carries eve sources in `eve/`, imported from [vercel/eve](https://github.com/vercel/eve)
at commit `eb5949a622801b35a2a6f78bb58d9eef27273cac` (eve 0.51.1).
The copy contains the eve package, its catalog dependency, package documentation and
build inputs. Iva's changes are ordinary commits in this directory, held by tests
on the boundary with Iva. Taking a newer upstream commit is a separate decision
(ADR-0023).

Edit the source in `eve/packages/eve/src/`, run the affected upstream tests and Iva
boundary tests, and commit the source. Maintainers use Node 24 or newer and pnpm
11.25.0. Choose a fresh `0.51.1-iva.N` in `scripts/build-eve.sh` and
`scripts/eve-release.sh` for each new archive. Users install the ready package;
they only build the Iva agent.

From a clean checkout:

```sh
bash scripts/eve-release.sh
```

The script calls `scripts/build-eve.sh`, keeps the archive in the ignored
`.eve-out/release/` directory, calculates its SHA-512 SRI and writes its URL,
version and integrity into `package.json` and `package-lock.json`. A second run
reuses the existing archive after checking its source and package hashes. An
existing archive with different source files requires a fresh version number.
For build comparison alone, use `bash scripts/build-eve.sh <empty-output-directory>`.

Publication order:

1. Commit the dependency files locally after building from committed sources.
2. Create `eve-0.51.1-iva.N` on that commit and push that tag.
3. Create the GitHub release in `smixs/iva-agent` and upload the matching archive.
4. Download the archive from the final dependency URL. Compute its SHA-512 SRI
   with `node -e 'const fs=require("fs"),c=require("crypto");console.log("sha512-"+c.createHash("sha512").update(fs.readFileSync(process.argv[1])).digest("base64"))' archive.tgz`
   and compare it with `package-lock.json`.
5. Run `npm ci` in a clean tree using that final URL, then run
   `node --test scripts/eve-copy.test.ts` and the boundary tests.
6. Push the dependency commit to `beta` after all checks pass.

Published `eve-*` tags and their archive assets are permanent and immutable:
keep their names and bytes. A correction gets a new N. Old Iva versions depend
on the old URLs. Archives stay outside git.

`node_modules/eve/BUILD.json` carries upstream commit, package/tool versions,
`sourceTreeHash` and `packedTreeHash`. `scripts/eve-copy.test.ts` checks the
source, installed contents and dependency lock. The path-dependent upstream
`.vendor-stamp.json` is excluded from the packed hash.

The sources retain the [Apache-2.0 license](../eve/LICENSE) and
[NOTICE](../eve/NOTICE), including the Iva modifications. Both files are also
included in the archive.
