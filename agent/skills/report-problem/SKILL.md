---
name: report-problem
description: "Something broke or the user complains: gather evidence and offer to file an issue or ask the support chat"
---

# Report a problem

Call this skill when the user complains about Iva ("you did not remind me again", "you do not answer"),
when a schedule, a tool or a delivery failed on its own, or after three failed attempts in a row.

1. Collect the evidence: run `iva diagnose` in bash. It writes `data/diagnose/<date>.md` and prints the path.
   Read the package before saying anything: versions, host, the whole `iva doctor` output, the last 200
   journal lines, the day's reminder facts and failed turns, the custom-layer file names.
2. Tell the owner what happened in two lines: what broke and what the package shows about it. Do not paste
   the package into the chat.
3. Offer the two ways out and wait for an explicit "yes" — publishing is the owner's move:
   - **Issue**: the ready link
     `https://github.com/smixs/iva-agent/issues/new?title=<two-line summary, URL-encoded>&body=<package cut to 6000 characters, URL-encoded>`.
   - **Support chat**: the address is the `SUPPORT_CHAT_URL` setting in `.env`. Give the owner the text to
     paste: the two lines of substance, the package path, and "the package has no secrets, the file can be
     attached". No `SUPPORT_CHAT_URL` — say the address is not configured and the owner should ask the admin.
4. Send nothing yourself: no issue, no message, no webhook. Cutting secrets is the code's work, not yours —
   the package is already redacted, and the file stays on the machine until the owner attaches it.
