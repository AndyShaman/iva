# Step 4 — Iva: install, repair, update, or leave alone

Read the state first (as `iva`, with `export PATH=$HOME/.local/bin:$PATH`):

```bash
ssh iva 'export PATH=$HOME/.local/bin:$PATH; command -v iva && iva version; iva status 2>&1 | tail -20; test -f ~/iva/.env && echo ENV_PRESENT'
curl -fsSL https://api.github.com/repos/smixs/iva-agent/releases/latest | grep -m1 '"tag_name"'
```

| State | Action |
|---|---|
| No `iva` command, no `~/iva` | First install → 4.1 |
| Installed, services active, version = latest release | Leave alone. Tell the person "Iva is already installed (version X) and running" and go to step 6 |
| Installed, services stopped or failing | `iva doctor` (it repairs what it can), then `iva restart`; read `iva logs` if still failing |
| Installed, older than the latest release | `iva update`, then step 6 |
| `~/iva` exists but no `.env` (an earlier run stopped) | First install with the env file → 4.1; the installer reuses finished stages |
| Iva under another user or path | ask the person which one is theirs; do not touch the other |

A Mac target: same table, run locally (no `ssh iva`).

## Branch

Install from `main` (the release). Use another branch only when the person asks for the beta (`beta`) or the
environment sets `IVA_INSTALL_BRANCH`: then fetch scripts from `https://raw.githubusercontent.com/smixs/iva-agent/<branch>/`
and run the installer with `BRANCH=<branch>` in its environment.

## 4.1 First install

Write the minimal env file from step 5 (`references/keys.md`), copy it to the server with mode 600, then:

```bash
ssh iva 'umask 077; cat > ~/iva-setup.env' < <local env file>
ssh iva 'curl -fsSL https://raw.githubusercontent.com/smixs/iva-agent/<branch>/install.sh | BRANCH=<branch> bash -s -- --env-file ~/iva-setup.env; rc=$?; rm -f ~/iva-setup.env; exit $rc'
```

`--env-file` runs without questions, including when a terminal is available. It is accepted for a first install or an
interrupted first install; a completed installation uses `iva config` instead.

The installer validates the keys, fills everything it derives (bearer, webhook secret, bot username, port, vault),
installs autostart and messages the person from the bot. It takes 3–10 minutes; the Chromium download is the longest
part. A dropped SSH connection stops setup and releases the installer lock. Recreate the temporary env file and run the
same command again: finished stages are skipped. An interactive repeat walks the setup with saved values as defaults.

Failure handling: read the last 40 lines of the installer output, fix the named cause (a wrong key or token → back to
step 5), re-run. Do not continue past a failed installer with manual steps.
