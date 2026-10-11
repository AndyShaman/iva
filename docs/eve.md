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
version and integrity into `package.json` and `package-lock.json`, and the version
and source/package hashes into the tracked `eve.lock.json` outside `eve/`. A second run
reuses the existing archive after checking its source and package hashes. An
existing archive with different source files requires a fresh version number.
For build comparison alone, use `bash scripts/build-eve.sh <empty-output-directory>`.

Commit the three dependency files locally, then publish with:

```sh
bash scripts/eve-release.sh --publish
```

The command verifies the clean committed tree and prepared archive, creates and
pushes only the `eve-0.51.1-iva.N` tag, creates its GitHub release and uploads the
archive, downloads the final URL and compares its SHA-512 SRI, then runs `npm ci`
in a temporary clean tree with an empty cache. It stops at the first failure.
Its final message allows the maintainer to push `beta`; that push remains a
separate action after the required acceptance checks. A different archive
location can be passed as the last argument in both modes.

Published `eve-*` tags and their archive assets are permanent and immutable:
keep their names and bytes. A correction gets a new N. Old Iva versions depend
on the old URLs. Archives stay outside git.

`node_modules/eve/BUILD.json` carries upstream commit, package/tool versions,
`sourceTreeHash` and `packedTreeHash`. `scripts/eve-copy.test.ts` checks the
source and installed contents against `eve.lock.json`, and checks the package's
BUILD metadata and dependency lock. Hashes include only the executable flag,
so file access permissions and umask do not change them. The build-only
`.vendor-stamp.json` is excluded from the packed hash; its script fingerprint
uses relative paths, so archive bytes are identical across build directories.

The sources retain the [Apache-2.0 license](../eve/LICENSE) and
[NOTICE](../eve/NOTICE), including the Iva modifications. Both files are also
included in the archive.
