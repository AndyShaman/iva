# Reminders

Ask Iva to remind you, and she will — at the right minute, in your timezone, in your chat. A reminder is not a note she might recall later: it is a row in `data/`, picked up by a dispatcher that wakes every minute. Restart the server, update Iva, roll the version back — the row is still there, and anything that came due while the machine was down fires on the first tick after it comes back.

## How to ask

Plain words in the chat, the way you would tell a person:

- «remind me in 30 minutes to call the clinic»
- «remind me at 14:30 to send the invoice»
- «on 14 September at 09:00 — the contract deadline»
- «every weekday at 09:00 remind me about standup»
- «what reminders do I have?» — she lists them
- «cancel the standup one» — she finds it and removes it

You never write the date arithmetic yourself and neither does she: you say when, Iva turns it into an exact moment and tells you back the time she stored. If the time she repeats is not what you meant, say so right away — that answer is the moment to catch a misunderstanding.

## Saying when

Two kinds of reminder, one way of asking for each. A one-time reminder fires once and disappears; a repeating one keeps its place in the list and moves on to its next occurrence.

| You say                                              | What it means                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------------ |
| `in 30m`, `in 1h 30m`, `in 2d`                       | a delay from now                                                   |
| `14:30`                                              | today at that wall-clock time; if it has already passed — tomorrow |
| `2026-09-14 09:00`                                   | that date and time on your wall clock                              |
| an ISO instant with an offset or `Z`                 | exactly that moment, wherever you are                              |
| a five-field schedule expression, e.g. `0 9 * * 1-5` | repeating: 09:00 on weekdays, in your timezone                     |

Everything is read in your timezone — the one Iva is configured with, not the server's. A date that does not exist on your clock (the hour skipped by a daylight-saving change, 31 February) is refused with that reason instead of being rounded to something nearby. So is a time in the past, and anything more than a year out.

## Two modes

Both kinds of reminder come in two flavours, and this is a separate choice from one-time versus repeating:

- **Verbatim** (the default) — your text arrives exactly as you dictated it, with no model involved. Fast, cheap, predictable.
- **Agent** — at the appointed time Iva takes a short turn first: she checks your tasks, sees whether the thing is still relevant, and writes the message herself. Ask for it in words: «remind me to prepare for the meeting, and look at my tasks first».

Use verbatim for «buy bread». Use agent when the reminder is about work in flight and a blunt copy of your own sentence would be less useful than a sentence that knows what happened since.

## Where to see the list

`/menu` → **⏰** shows the nearest reminders — the time each one fires, a repeat marker on recurring ones, and the first words of the text. Above them is one line about the dispatcher: when it last ticked. A fresh tick means the machinery is alive; a stale one, or none at all, is flagged, and that is your signal that reminders are stored but nothing is firing — usually because the service is down.

You can also just ask in the chat: Iva lists the same rows with their ids, and cancels any of them by id or by description.

## When delivery fails

Telegram can be unreachable, a chat can be misconfigured, a turn can time out. None of that silently loses the reminder:

- the row stays and is retried, at most once every five minutes;
- a one-time reminder keeps trying for six hours, then is dropped — one warning arrives with the full original text in it;
- a repeating one tries for thirty minutes, then gives up on that occurrence and waits for the next one;
- after the second failure in a row you get one short warning: what broke, until when Iva will keep trying, and how to cancel the reminder. At most one such warning per hour per reminder, so a broken chat cannot turn into a flood.

Failed rows are marked in the `/menu` list, so you can spot a stuck one without waiting for a warning.

## What Iva no longer does

She used to be able to build her own timer: a transient system unit, a `crontab` line, a `sleep` loop with a `curl` to the Telegram API, a small script of her own. All of that is now refused before it runs, and the refusal names the reminder tool as the replacement.

This is not bureaucracy. Home-made timers failed in exactly three ways: they did not survive a reboot (a transient unit lives in memory), they required converting your local time to the server's by hand and got it wrong by hours, and they were invisible — nothing listed them, nothing showed their status, and a silent failure looked identical to success. A reminder in the table has none of those properties.

Reading is untouched: Iva can still inspect `crontab -l`, service status and the journal. The block is a foot-gun guard, not a security boundary — it stops a wrong habit, not an attacker.

## Limits

- **Owner chat only.** Reminders arrive in your chat with Iva. Other recipients — a forum topic, another person — are not supported.
- **No more often than every ten minutes.** A repeating schedule tighter than that is refused: that is a monitoring job, not a reminder, and it would flood the chat.
- **Your timezone, one of them.** Everything is computed in the timezone Iva is configured with; reminders for someone in another zone would need that zone spelled out, and today there is one.
- **A reminder is a message, not a task.** It fires and it is done (or, if repeating, moves to the next occurrence). For work you track over time, use tasks — Iva keeps those separately, and an agent-mode reminder can read them.
