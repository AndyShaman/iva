# TLA+ models

The repository keeps bounded models of the lock, the night writer, restart recovery, proactive notices, plugin proposals, idle compaction, the tap on a model's button and the drain of the Bridge queue in batches. Run them from a temporary directory because TLC writes state files beside the model.

## FileLock

`FileLock.tla` models the directory lock, owner token, heartbeat, stale takeover, crashes and bounded event-loop delay. The configurations vary process count, stale interval, deadline and synchronous holders:

- `FileLock.cfg`
- `FileLock-2p.cfg`
- `FileLock-deadline.cfg`
- `FileLock-hold.cfg`
- `FileLock-lag.cfg`
- `FileLock-slow.cfg`
- `FileLock-sync-slow.cfg`
- `FileLock-witness.cfg`

Example:

```sh
d=$(mktemp -d)
cp specs/FileLock.tla specs/FileLock.cfg "$d"/
(cd "$d" && tlc -workers 2 -deadlock -config FileLock.cfg FileLock.tla)
```

The model assumes that a live asynchronous holder's event loop runs often enough to refresh the lock before the stale threshold. A fully stopped process can still lose the lock after that threshold. Filesystem errors and unknown directory members are outside the model and covered by executable tests.

## NightWriter

`NightWriter.tla` models one writer under the memory lock: a model call whose answer is cached before any write, a whole-section replacement guarded by the file hash read for the call, an owner edit racing the night, commit-gated readiness, a crash at any step and restart, and an ordered queue of days. On a hash mismatch nothing is written, the answer is dropped, the Card gets `truth_pending` and the day still closes; the call repeats next night.

`Replace` and `Conflict` are single steps, and `HumanEdit` is enabled only while the night waits for or holds the answer, because the hash check, the write and the commit run under the Card lock that the day writers take too (`write_card`, CORE through `writeCore`): an owner edit cannot land between the check and the write.

```sh
d=$(mktemp -d)
cp specs/NightWriter.tla specs/NightWriter.cfg "$d"/
(cd "$d" && tlc -workers 2 -config NightWriter.cfg NightWriter.tla)
```

Checked invariants:

1. `FileNeverPartial`: the visible file is always one complete old, new or owner version.
2. `ReadyOnlyAfterCommit`: a ready day has passed the commit state.
3. `HumanEditWins`: an observed owner edit is not overwritten by the night.
4. `NoSecondCall`: a restart reuses the cached answer; a second paid call happens only when the crash hit the call itself.
5. `QueueDrains`: with the stated fairness assumptions, the bounded queue reaches zero.

Mutants that must fail: the hash check removed (`HumanEditWins`), restart without the cache (`NoSecondCall`), readiness without a commit (`ReadyOnlyAfterCommit`). After a restart an uncommitted new file is committed first, before any call — the production contract of the night's opening sweep.

## Proactive

`Proactive.tla` models the half-hourly proactive run before its code exists (`scripts/proactive/tick.ts`): a no-wait lock that expires `staleMs` after it is taken, the state file `data/proactive.json` written whole from the run's memory, the Brief claim and turn, the Insight claim and turn (a run with an Insight ends after it, without Watch), the Watch claim before the turn, delivery and the `wakes` write after it, a crash or a failed write at any step and the runner's deadline. One `Tick` is 8 minutes: a 40-minute `staleMs` gives `Stale = 5`, a run that lives at most `timeoutMs + killGraceMs` (31 min 30 s, at most 4 boundaries) gives `MaxRun = 4`; the run itself cancels a turn at `IVA_JOB_STOP_AT`, and after a Brief that ran past its deadline Watch does not go. A comment in the model maps every action to its future file and function.

Checked invariants:

1. `NoDoubleTake`: a key reaches at most one turn between two growths of its unread count.
2. `OneBriefPerSlot`: one Brief per slot and day.
3. `WakesCapped`: ordinary wakes with a message per day stay within `watchCapPerDay` plus the number of runs lost between delivery and the `wakes` write.
4. `OneRun`: two runs never overlap.
5. `OneInsightPerDay`: at most one Insight turn per owner's day.

The run takes its `now` right after the lock (`NowAfterLock = TRUE`). Witnesses must fail, each on its own invariant first: `Proactive-noclaim.cfg` (claim after the turn, 1), `Proactive-nolock.cfg` (no lock: 4, then 1, then 2), `Proactive-nocap.cfg` (no cap filter, 3), `Proactive-shortstale.cfg` (`staleMs` shorter than a run, 4), `Proactive-nowfirst.cfg` (`now` taken before the lock: a run with an older day overwrites `briefDone` written for a newer day, 2, and without 2 the Insight day, 5), `Proactive-noinsightclaim.cfg` (Insight claim after the turn, 5), `Proactive-dropinsight.cfg` (a Brief or Watch write that drops the `insight` field, 5); without the lock and without 1–4 `Proactive-nolock.cfg` also fails on 5. Every earlier witness line drops `OneInsightPerDay` as well: without the lock or with `now` taken before it, a double Insight is as short as a double Brief and could come out first. The Ceiling of the day (`proactive.ceilingTokensPerDay`) is outside the model like `modelWakesPerDay`: it only drops candidates, and the model already takes any subset of them. The `?` mark and the draft fingerprint of the Insight are outside the model: they do not depend on the order of events and are written under the same lock; property tests cover them. An Insight has no pause (ADR-0022).

```sh
specs/proactive-check.sh
```

## PluginProposal

`PluginProposal.tla` models the life of a plugin proposal (ADR-0009) and was written after the code: it checks the code, not a design. Two identical `iva plugin propose` runs (sweep, claim by rename, utimes, send, removal on a failed send), two taps of the one button in the Bridge (take by rename, age check and the tap time on the taken copy, tree hash check, installer launch or return), the installer (first hash check, copy into its own staging, hash check of the staged copy, install, removal of the taken copy), a second writer changing the files of the proposal or the taken copy, and a crash at every step of every process. One `Tick` is a boundary; a day is `TTL = 2`. The comment in the model maps every action to its function.

The model assumes that a holder of the taken copy (a tap before launch, a live installer) finishes within a day of its tap, and that `renameSync`, the age check and the stamp in `takeProposal` run without an `await` between them, so the other tap of the same Bridge cannot interleave (`BridgeFree`). Without the second assumption TLC finds two taps holding one taken copy: tap A takes an old copy, the sweep removes it, a new proposal and tap B put a fresh copy under the same name, and A stamps it as its own.

Checked invariants:

1. `OneInstaller`: at most one live installer per proposal.
2. `OnlyButtonBytes`: the store receives only bytes whose tree hash is the button's.
3. `SweepSparesTaken`: the sweep never removes a taken copy while a tap or an installer holds it.

Witnesses must fail: `PluginProposal-norename.cfg` (the tap copies the proposal instead of taking it by rename, `OneInstaller`, checked without `SweepSparesTaken`, which breaks at the same depth), `PluginProposal-nostamp.cfg` (the taken copy keeps the propose time, as before the repair, `SweepSparesTaken`), `PluginProposal-nostaged.cfg` (the installer checks only the taken copy and installs its copy unchecked, as before the repair, `OnlyButtonBytes`).

```sh
specs/plugin-proposal-check.sh
```

## IdleCompaction

`IdleCompaction.tla` models the compaction between turns (ADR-0021) and was written after the code: it checks the code, not a design. One eve session in one chat: the bridge (routing under queue or steer, replies to bot messages, the disk queue, the drain, the reaper), the chat status record, the process memory of `agent/lib/idle-compaction.ts` (with the open ask `reclaim`), eve's input buffer, control queue and current action, the compact POST that the `session.waiting` handler awaits with its outcomes (accepted, refused, unknown, accepted after the client's timeout), the `compaction.requested` hook that claims the chat again, `/stop` and steer aborts in eve's order (parking, `turn.cancelled`, parking), and a restart with the ExecStartPre quarantine. The comment in the model maps every action to its function and lists the assumptions about eve (facts Ф3–Ф13 of the spec).

Checked on the code with a late compact request allowed, queue and steer (`IdleCompaction.cfg`, `-steer`): every invariant of spec section 7 (`QueuedWhileCompacting`, `CompactionGuarded`, `TurnRecordKept`, `NoFalseInterruptNotice`, `NoCancelMarkForCompaction`, `CompactingNeverInTurn`, `OffOnlyAfterUselessCompaction`, `AtMostOneAskPerTurn`, `NoStackedCompaction`, `NoAskOverCompactingRecord`, `NoAskWhileOff`) and the liveness `NoLostMessage` and `ChatFreed`. With a restart (`-restart`, `-restart-steer`) the safety invariants and `NoHangAfterRestart` hold, except `CompactionGuarded` and `QueuedWhileCompacting` (F7, `-restart-guarded`): a late request queued in eve survives the restart while the process memory does not. The proposed repair `BeginAnyIdle` (R5, a model switch, not code) makes `-r5` and `-r5-steer` pass every safety invariant. The drain hands eve the queued messages as one batch, and a message waits behind a non-empty queue under steer too (route R1 of `.scratch/work/wave-1010/l5/spec-v2.md`).

Findings that must fail: the window between the start of a late compaction and its hook (`-window`: `QueuedInRequestWindow`; `-window-restart`: `NoHangInRequestWindow`, F6); a message already in eve's input lost without a notice by a restart mid-compaction (`-silentloss`) and waiting in that input (`-inbox`); a compaction longer than `RUN_STALE_MS` reaped while a buffered turn runs without a record (`-turnhang`, outside the feature).

Witnesses must fail: `-offfail` (R3 off: `OffOnlyAfterUselessCompaction`), `-nobeginclaim` (no claim on `compaction.requested`: `CompactionGuarded`), `-noaskguard` (a second ask while one is open: `NoStackedCompaction`), `-releasebysession` (on the base without the await: `TurnRecordKept`), `-noclaim` (`QueuedWhileCompacting`), `-noopenguard` (`OffOnlyAfterUselessCompaction`), `-noisyreap` (`NoFalseInterruptNotice`), `-turnkeeps` (`CompactingNeverInTurn`), `-dueagain` (`AtMostOneAskPerTurn`), `-offnotchecked` (`NoAskWhileOff`), `-repliesdirect` (`QueuedWhileCompacting`), `-noreap` (`ChatFreed`). `-void` (no await) and `-noparkrelease` pass: the hook's claim covers the first, the reaper the second.

The queued sign (the loader shown under a message that waits behind a live turn, its message id kept in the chat record as `queued*`) is in the model since it was added to the code: `SignOwned` — while the sign is shown, the record keeps its id, and a live record holds it or a turn that will take it is pending; a record that goes idle with no such turn has deleted it. The exceptions are a restart that rewrote a compacting record before any Bot API was up (the next turn start deletes the sign) and the session hung by F6. It holds on every code configuration; `-reapkeepssign` (the reaper leaves the sign) and `-rewritelosessign` (the restart rewrite drops the `queued*` fields) and `-claimdropssign` (the compaction claim drops them) must fail on it.

```sh
specs/idle-compaction-check.sh
```

## ButtonTap

`ButtonTap.tla` models the Bridge's answer to a tap on a model's button (ADR-0015) and was written before the code (`scripts/poller/control.ts`): one button of one message, taps that arrive as updates with new `update_id`s, the in-process memory of taps (button key to the `update_id` that became a message), the edit that marks the button in flight, landing or failing, admission to the queue with the outcomes `owned` and `write-failed` (Telegram hands the same update out again), and restarts of the Bridge that empty the memory. A tap on an already marked button is allowed: that clients refuse a tap on a `disabled` button is not proven, so only the memory guards against a second message.

Checked invariants:

1. `NoSwallow`: the button is not marked, and no edit is in flight, without a tap that is in the queue or still to be handled.
2. `OnePerProcess`: while the Bridge lives, one button gives at most one message.

Witnesses must fail: `ButtonTap-keyonly.cfg` (a repeat is judged by the key alone, without the `update_id`: the same update handed out again after `write-failed` is dropped, `NoSwallow`), `ButtonTap-nomemory.cfg` (no memory: every tap becomes a message, `OnePerProcess`).

```sh
specs/button-tap-check.sh
```

## QueueDrain

`QueueDrain.tla` models the drain of the Bridge queue in batches (spec `.scratch/work/wave-1010/l5/spec-v2.md`, section 7) and was written before the code: it checks the design. One chat, two authors, messages that join a batch (`plain`) or go alone (`alone`: a command, a reply, a tap on a model's button, a message without `from`); the inbox of each author with routing and the removal from the inbox as separate steps; routing to the queue or a direct delivery, with route R1 (`QueueFirst`: while the chat's queue is not empty a message waits behind it under steer too) and, with `Replies`, an `alone` message that may skip the queue as a reply to the bot; the drain (a batch pinned until its removal, else `queueBatchLength`), a delivery whose id is the last item of the batch, removal of the batch with one write; eve's ledger of delivery ids that began a turn (`handled` for a known id) and the loss of an id from it; a delivery accepted after the Bridge's deadline; a busy chat (a turn or a compaction); `queueInFlight`; the owner switching between queue and steer; a Bridge restart. `Loop = "seq"` follows the code's main loop (inbox promotion, then a drain pass); `Loop = "any"` lets routing land between any steps of the drain, wider than the code. The inbox collector, limits in parts and characters (`MaxItems` items instead), `/new` with `clearChatQueue`, `closed-session`, negative ids without a ledger and time are outside the model. Ids are compared only for equality, so numbering them in arrival order loses nothing; the authors are symmetric, so the first message comes from `a`.

Checked invariants:

1. `NoLoss`: every message that arrived is in an inbox, in the queue or was in at least one turn.
2. `NoDupBeyondBreak`: a message is in two turns only when a restart cut its delivery (a batch in flight or pinned, a routing not yet removed from the inbox), its direct delivery ended for the Bridge without an answer while eve began the turn, or the ledger lost the id of a delivery that carried it.
3. `QueueOrder`: first appearances of messages that came to a turn from the queue follow their first enqueue order.
4. `WholeBatch`: a batch chosen without a pin is a prefix of the queue, allowed and maximal.
5. `AloneStaysAlone`: a turn from the queue with an `alone` message holds only that message.
6. `BatchAtHead` and `PinAtHead`: the batch in flight and the pin stand whole at the head of the queue, so `removeQueueItems` never meets a batch off the head and a partial pin never happens.

The design of spec v2 passes every invariant with routing between any steps of the drain, a late acceptance, replies that skip the queue, a restart and two switches of the policy, starting under queue (`QueueDrain.cfg`) and under steer (`-steer`), and with a lost ledger id (`-ledgerloss`). Without R1 the drain loses a message (finding F1, `-switch` and `-switch-norestart`, in the code's order): after the owner switches queue to steer while messages wait, a direct delivery overtakes the queue and puts its id into the ledger; a later batch that ends with this id gets `handled`, and the message before it in the batch is lost. A reply to the bot overtakes the queue under R1 too, but it always goes alone, so its id is never the last id of a batch of several items.

Witnesses must fail: `-staleack` (the removal writes the snapshot of the pass without the batch, `NoLoss`), `-nopin` (no pin: a batch accepted after the deadline is counted again with a new last id, `NoDupBeyondBreak`), `-anysender` (batches of any authors, `NoLoss`), `-mergealone` (`alone` joins a batch, `AloneStaysAlone`), `-switch` and `-switch-norestart` (no R1, `NoLoss`).

```sh
specs/queue-drain-check.sh
```

## Helpers

`HelperRun.tla` and `HelperOutcome.tla` check the Helpers design before product code.
They follow spec v4.4 and the lead's round-2 acceptance: **OneDeliveredPerTurn** is
the delivery guarantee. The earlier SPEC-FIX-3 proposal was rejected: T12 uses its
ordinary conditions, and cleanup requires no additional knowledge of turn activity.
The historical read-count counterexample remains a diagnostic witness.

`HelperRun` has three initially pending helpers, two server processes before and
after one restart, two durable running slots, two claim tokens in the main safety graph, one deadline
tick and one remote step. Three-claim witnesses check the next allocation and
remote-tail pressure. `create(message)` begins the remote turn immediately.
Server `session.started` and client `onSession` independently write T3 under CAS.
A failed client write cancels using the client's known session id and waits for
remote completion (`WaitClientEnd = TRUE`, accepted SPEC-FIX-2). Cancel acceptance,
an error and silence retain the slot; a dead client is handled by T9.

The named §3.7 exception is represented by `unrecordedRelease`: T9 can release
an unrecorded session's slot while its bounded remote tail still runs. Actual
server turns can temporarily exceed the durable slot limit. `WithinLimits`
counts durable slots; `SlotFreedAfterEnd` explicitly allows only that exception.

`HelperOutcome` has two rows of one chat, initially running or finished, and both
queue and steer policies. A closed-row read returns an envelope without writing
`shown`. T14's finished-row guard checks the row table. T15 marks every eligible
finished row with a matching `shown.turnId` after a successful nonempty Outbox;
its historical observer checks that one turn marks at most one distinct row.
Observers preserve evidence after T12 deletes a row.

A response can now have **two successful final Outbox events with the same turn
id**, each followed by an independent T15. `MarkDelivered` retains the turn;
`SecondOutbox` emits the continuation; `EndTurn` releases the chat separately.
Close, cleanup, a failed T15, cancellation, owner messages, `/new` and crashes
can occur between these events. T12 may delete the first delivered row before
the second T15: `deliveredByTurn` still observes the first mark. `outboxParts` and
`markedParts` bound the event count to two; the product needs no first-read memory
or cleanup delay. `toldCount` counts one whole retelling, including its continuation.

The final text is already prepared when Outbox starts. T14 is allowed before
that point; further tool calls during transmission of that same final text are
outside this model. This follows the Telegram channel boundary: tool-call
`message.completed` events return through the progress path before Outbox,
and final text uses `sendThroughOutbox`. The multipart replay includes T12
between two successful Outbox/T15 pairs, and a reachability witness proves
that both T15 actions actually ran with the same turn id.

The model also includes a second-read rejection, partial sends, failed T15 writes,
a lost Bridge reply, a stale T16 receipt, an owner message during a wake turn
and `/new`. T17 persists escalation with a threshold of one instead of six.
Retention time and backoff are abstracted as eligible transitions. An unanswered
wake or a response reading only an unrelated closed row consumes the finite
failure count; closing the wake's own target permits normal completion.
Semantic retelling quality remains outside the model.

| Model action                                                                                                            | Future code / transition                                                     |
| ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `Add`, `ClosePending`, `CloseRunning`, `CloseFinished`, `Sweep`                                                         | `agent/lib/helper-store.ts`: T1, T11, T12, `finalize`                        |
| `Claim`, `ChildStarted`, `ChildFailedToStart`, `Tick`, `NoActiveTurn`                                                   | `agent/lib/helper-tick.ts`: T2, T2c, T2f, T9                                 |
| `CreateSession`, `ClientRecordSession`                                                                                  | `scripts/helpers/run.ts`: `create(message)`, client T3                       |
| `ServerRecordSession`                                                                                                   | Server hook for helper `session.started`: server T3 (§3.8)                   |
| `Stop`, `PrepareFinish`, `CommitFinish`, `CrashProcess`                                                                 | `scripts/helpers/run.ts`: T5, T7, process failure                            |
| `TurnEnds`, `ServerStep`, `Restart`                                                                                     | eve turn lifecycle, step bound Я3, systemd restart                           |
| `HelperFinished`, `Close`, `Sweep`                                                                                      | `agent/lib/helper-store.ts`: T7, T11, ordinary T12                           |
| `AllocWake`, `SendWake`, `StampWake`, `ReplayReceipt`, `Escalate`                                                       | `scripts/poller/helper-wake.ts`: T13, direct admission, T16, T17             |
| `ReadOutcome`, `ReadSecondOutcome`                                                                                      | `agent/lib/helper-tool.ts`: T14, finished-row marker and closed-row envelope |
| `OutboxFull`, `SecondOutbox`, `MarkDelivered`, `T15WriteFailure`, `OutboxFailure`, `PartialSend`, `ResponseWithoutRead` | Telegram channel, Outbox and helper `message.completed` hook: T15            |
| `EndTurn`                                                                                                               | Server `turn.completed` and chat release after final output                  |
| `OwnerMessage`, `CancelTurn`, `FailTurn`, `NewConversation`                                                             | `scripts/poller/routing.ts`, `scripts/poller/control.ts`                     |
| `LoseBridgeReply`, `BridgeCrash`, `ServerCrash`                                                                         | Bridge transport/process and server restart                                  |
| `BridgeStep`                                                                                                            | Fair Bridge/chat progress after finitely many failures                       |

Current safety: `OneRun`, `WithinLimits`, `OutcomeOnce`, `StopOnce`, `ClosedFinal`,
`SlotFreedAfterEnd`; `DeliveredOnlyAfterShownAndOutbox`, **`OneDeliveredPerTurn`**,
`ClosedHasNoDelivery`, `NoWakeWhileBusy`, `WakeIdUnique`, `WakesCountedOnce`,
`DupOnlyWithoutDurableMark`, `UndeliveredKept`.
`OneOutcomePerTurn` remains only a historical read-count diagnostic in the two
`spec-v43` / `spec-v44` witnesses. Round-2 acceptance rejected that guarantee.

Liveness: `NoSilentEnd`, `UnrecordedTailEnds`, `EventuallyDelivered`. §7 assumes
fair ticks and eventual server progress (`WF(ServerStep)`); permanent silence
keeps a known session's slot occupied. Delivery assumes fair Bridge/chat progress,
one failure per trace, one owner message and one `/new`. Five wake ids and six
turn ids cover two ready outcomes and interruptions. The two output parts share
the same turn id. Increasing these bounds requires another check.

Main `VIEW`s collapse independent diagnostics and completed metadata, retaining
values that affect the checked properties or future meaningful transitions.
`HelperRun` preserves all active remote-tail metadata and collapses final outcome
kinds to presence of an outcome; its mutants use `FullView`. Delivery collapses
escalation flags, second-read diagnostics, restart counters, the duplicated
conversation count and returned-envelope identities (emptiness controls progress).
Current multipart event counts and all historical shown/delivery/outbox evidence
remain in the view. Old multipart counts are never read again because turn ids
are never reused. Run writer labels collapse to pending/completed; the recorded
session flag and cancel phase retain their effects. Deadline and ceiling share
the same transition guards and terminal status; the closed reason stays distinct.
Helper identity symmetry is used only in the full safety graph. Liveness and
witnesses use no symmetry; all configurations use no state constraints.

| Configuration                   | Expected first result                                                         |
| ------------------------------- | ----------------------------------------------------------------------------- |
| `HelperRun`, `HelperOutcome`    | No errors, all safety invariants on the documented bounds                     |
| `HelperRun-live`                | No errors, both temporal properties with two competing helpers                |
| `HelperOutcome-live`            | No errors, delivery with owner queue/steer and every failure class            |
| `HelperOutcome-live-new`        | No errors, delivery with `/new` and every failure class                       |
| `HelperRun-pressure`            | No errors: three remote turns with two durable slots                          |
| `HelperRun-pressure-reach`      | `NoThreeRemoteTurns` (third remote-turn reachability witness)                 |
| `HelperOutcome-oldcounter`      | No errors: original closed-read replay under v4.4                             |
| `HelperOutcome-close-sweep`     | No errors: rejected SPEC-FIX-3 race satisfies `OneDeliveredPerTurn`           |
| `HelperOutcome-multipart`       | No errors: two Outbox/T15 pairs with T12 between them                         |
| `HelperOutcome-multipart-reach` | `NoMultipartCompletion` (two-part reachability witness)                       |
| `HelperRun-nofinalize`          | `OutcomeOnce`                                                                 |
| `HelperRun-noreap`              | `NoSilentEnd` (temporal)                                                      |
| `HelperRun-ownerme`             | `OneRun`                                                                      |
| `HelperRun-nolimit`             | `WithinLimits`                                                                |
| `HelperRun-earlyfree`           | `SlotFreedAfterEnd`                                                           |
| `HelperOutcome-busy`            | `NoWakeWhileBusy`                                                             |
| `HelperOutcome-arithmetic`      | `WakeIdUnique`                                                                |
| `HelperOutcome-noshown`         | `DeliveredOnlyAfterShownAndOutbox`                                            |
| `HelperOutcome-nostampcas`      | `WakesCountedOnce`                                                            |
| `HelperOutcome-dropundelivered` | `UndeliveredKept`                                                             |
| `HelperOutcome-spec-v43`        | `OneOutcomePerTurn` (historical read-count diagnostic)                        |
| `HelperRun-spec-v43`            | `SlotFreedAfterEnd` (accepted SPEC-FIX-2 witness)                             |
| `HelperOutcome-spec-v44`        | `OneOutcomePerTurn` (SPEC-FIX-3 rejected: guarantee is `OneDeliveredPerTurn`) |
| `HelperRun-unrecorded`          | `NoUnrecordedTail` (reachability witness)                                     |
| `HelperRun-bothwriters`         | `NoBothWriters` (reachability witness)                                        |
| `HelperRun-serveronly`          | `NoServerOnly` (reachability witness)                                         |

```sh
cd specs
PATH=/opt/homebrew/opt/openjdk@25/bin:$PATH JAVA_TOOL_OPTIONS=-Xmx3g sh helper-check.sh

# Optional sampled traces:
CHECK_MODE=simulate SIM_TRACES=2000 TLC_TIMEOUT=120 sh helper-check.sh
```

Java, GNU `timeout` and TLC must be on PATH (or set `TLC` / `TIMEOUT`). Each TLC
runs in the foreground with a 600-second deadline and a 5-second kill grace.
State directories live under `.scratch/helper-tla/check.*` in the worktree and
are removed on exit. `LOG_DIR` optionally preserves bounded text logs. Errors,
timeout, a wrong first invariant and unexpected exit codes fail the script.
Its output separates BFS `distinct` from simulation `checked`.
The 27 configurations include nine positive checks and 18 witnesses.

Delivery liveness uses `LiveView`: it retains all durable row/wake state,
finite interference counts and current shown/parts markers. Older safety-only
histories never guard operational actions; safety still checks them in `View`.
Every BridgeStep changes retained state, preserving weak fairness and the
EventuallyDelivered predicate. This removes redundant copies of the same
progress state with different histories of completed turns.

The main `.cfg` files check every safety invariant without temporal properties.
`HelperOutcome` retains full safety constants. The three-claim `HelperRun` safety
graph exceeded the ten-minute deadline even with symmetry: its last progress
sample had 23,819,968 distinct states and 10,421,725 queued states. The main safety
graph therefore retains three initially ready helpers and reduces `MaxClaims`
from three to two. Both claimed helpers traverse the full Next relation; the
third row may close but cannot claim after the token bound. Exhaustive arbitrary
interleavings of three claimed helpers are outside this bounded main graph.
With two claim tokens, `WithinLimits` in this main graph is also implied by the
token bound. `HelperRun-nolimit` checks the actual third-claim admission guard
by violating the ceiling when that guard is removed.
`HelperRun-pressure` checks all safety invariants on an exact three-claim replay:
a failed server T3, dead first client, T9 release without id, then three actual
remote turns with two durable slots. Its companion reachability witness fails
`NoThreeRemoteTurns`, proving that this state was reached. Those configurations
retain three claim tokens and full state without symmetry.

`HelperRun-live` retains two competing helpers, one
slot, two claim tokens, both T3 writers, death, cancellation and restart. Each
helper can claim only once; a third helper adds finite interference and exercises
the third-claim boundary in the pressure and no-limit witnesses. Each
Tick/ServerStep progress guard reads only its own helper and server state,
so changing the slot count affects only Claim admission, before the run enters
the NoSilentEnd obligation. One slot retains waiting, serial claims and overlap
of an unrecorded remote tail with the next claimed helper. Two simultaneously
occupied durable slots remain in safety. Per-helper progress
still depends on fair Tick and ServerStep, including an unrecorded remote tail.
`HelperRun-noreap` uses the same two-helper bounds with full diagnostic state.

Delivery keeps both rows and both policies in each liveness graph. The owner
profile has one failure and one owner message; the `/new` profile has one failure
and one `/new`. Each profile checks all failure actions, Outbox/T15 windows,
closure and deletion. Wake ids remain five; turn ids are six and five respectively.
With one shared failure, steer and `/new` during an active turn cannot both abort
turns in one trace. A `/new` in a free chat changes only the finite conversation
count, clears the finite owner queue/reply and preserves all durable helper state;
its interleaving adds finite delay or removes queued work. After finite owner,
`/new`, failure and row-close actions, the same fair BridgeStep advances remaining
ready rows. Full safety retains the combined owner plus `/new` traces. These are
bounded checks of the stated design, with the usual obligation to recheck changed
bounds and actions.

Temporal checking runs once on the completed BFS graph (`-lncheck final`). This
preserves complete liveness checking while avoiding repeated checks of growing
partial graphs. Each main check uses eight workers and has a ten-minute deadline. Temporal
counterexample witnesses use the default early temporal checks.

The models abstract file contents, physical writes, locks, Trace/Alert delivery,
memory thresholds, PID reuse, wall-clock bounds and token accounting. Delivery
keeps one active chat turn, with one or two final output parts. Late overlapping
turns from a lost admission-ledger write, retrieving already delivered outcomes,
additional tool calls after final text starts transmitting and semantic reply
quality require separate checks.

## GoalCheck

`GoalCheck.tla` проверяет дизайн поручения, которое помощник проверяет по расписанию
(Goal v3.1, §3.2–3.7, §4 и §7). `helpers.json` меняется атомарно под замком.
Два клиента сохранения отдельно читают `last.md`, сравнивают `finishedAt`,
переименовывают файл и отмечают `saved` в таблице. Владелец может поправить или
закрыть поручение между любыми двумя шагами, включая уже записанный `stop: deadline`.

```sh
PATH=/opt/homebrew/opt/openjdk@25/bin:$PATH JAVA_TOOL_OPTIONS=-Xmx3g sh specs/goal-check.sh
```

Скрипт делает полный BFS последовательно на восьми потоках, ограничивает весь
набор 600 секундами и каждый запуск 150 секундами. Рабочие каталоги TLC создаются в
`.scratch/goal-tla` и удаляются при выходе. `LOG_DIR=/absolute/path` сохраняет
журналы и `results.tsv`; `TLC` и `TIMEOUT` задают существующие программы.

В модели два id поручения. Конфигурации разделяют пространство: `GoalCheck.cfg`
проверяет все вердикты, исходы и одну правку; `-crashes` — обрывы и перезапуск;
`-owner` — две правки и `rev = 3`; `-failures` и `-failures-live` — два сбоя и
паузу; `-limits` — расход и срок жизни; `-live` — четыре свойства живости;
`-capacity` — два действующих поручения, до трёх строк поручений и одну обычную;
`-capacity-reach` подтверждает достижимость полной таблицы контрпримером
`NoFullTable`; `-day-cap` допускает три проверки за жизнь поручения, чтобы
проверить дневной предел независимо от общей длины трассы;
`-history` — две последовательные проверки и двух писателей файла; `-day` —
загруженное действующее поручение после двух тихих проверок предыдущего дня.
`reportNext` отражает наличие `next_check` в отчёте: полный сценарий перебирает
оба варианта, остальные сценарии фиксируют его наличие. Текст без `report`
сохраняет срок по умолчанию, как требует правило 3. Эти сужения задаются
в `.cfg`: число проверок на трассу 1–3, правок 0–2, отказов 0–1. День циклический
по модулю 2; дневной предел 2, предел сбоев 2. В `-capacity`/`-day-cap` рассматривается окно отказа записи файла,
владелец продолжает поручения; закрытие и сохранение проверяются остальными
конфигурациями. Id строк на трассе используются
однократно; новый срок после исчерпания числа проверок остаётся будущим.

Служебный `audit` удерживает результат проверки каждой атомарной записи против
состояния до записи. `TrackSafety = FALSE` в конфигурациях живости убирает расчёт
этого наблюдателя: переходы `s` совпадают с проверками безопасности. `lastSaved`,
исходы убранных строк и счётчики сохраняются как свидетельства после уборки;
физический файл определён до уборки поручения.

Все свойства §7 заданы формулами: `OneLiveCheck`, `ClaimOnlyActive`,
`CancelChangesNothing`, `OwnerNextKept`, `ContentReportTold`, `SilentBranches`,
`FailureCount`, `OneUntoldPerGoal`, `NoStaleNotice`, `ClosedMeansClosed`,
`NoSweepBeforeSaved`, `LastSavedMonotone`, `GoalOutlivesRows`, `OnlyOwnerActs`,
`RowsBounded`, `DayCountBounded`; живость — `CheckReleased`, `DueServed`,
`PauseTold`, `ContentSaved`. `CheckReleased` относится к конкретному захвату id,
`DueServed` учитывает новую постановку и перенос уже наступившего срока владельцем.

Три находки дизайна сохранены конфигурациями с ожидаемым контрпримером:

1. **SPEC-FIX-1, `-spec-file-race`:** чтение и сравнение вне замка таблицы позволяют
   старому писателю переименовать файл после нового. Предложение к §3.4, шагу 1:
   отдельный замок на поручение держится от чтения до переименования `last.md`.
   G9 берёт тот же замок при удалении каталога; отметка `saved` остаётся записью
   таблицы. `SerializeLast = TRUE` моделирует это предложение.
2. **SPEC-FIX-2, `-spec-weak-fair`:** слабая справедливость тика допускает
   повторяющиеся нетихие окна, в каждом из которых захват пропущен. Смена дня
   также делает нормализацию доступной периодически; WF позволяет откладывать
   эти действия. Предпосылка живости: повторяющиеся возможности
   нормализации дня и захвата обслуживаются — `SF_vars(NormalizeDay(g))`
   и `SF_vars(Due(g))`; так же обслуживаются извещения и вход в замок файла. `Due` нормализует день под тем же
   замком, как требует §3.3. Это уточнение предпосылки среды.
3. **SPEC-FIX-3, `-spec-owner-failure`:** буквальное `OwnerNextKept` противоречит
   правилу 4 §3.4, назначающему срок по умолчанию. Проверяемая формула сохраняет
   срок владельца при правилах 1–3; отмена отдельно проверяется
   `CancelChangesNothing`. Исходная формула — `OwnerNextKeptLiteral`.

Каждый из 15 свидетелей §7 имеет собственную конфигурацию: `-norev`, `-noclosed`,
`-owner-time`, `-doublecheck`, `-split`, `-pending-close`, `-require-done`,
`-quiet-empty`, `-content-failure`, `-sweep-unsaved`, `-no-compare`,
`-notice-untold`, `-edit-owes`, `-close-untold`, `-nonormalize`.
Сначала скрипт требует зелёный дизайн, затем точное имя свойства и код TLC 12
для нарушения инварианта либо 13 для нарушения живости. Каждый отрицательный
конфиг проверяет одно названное свойство, что даёт однозначный первый отказ.

| Действие модели                                            | Место в будущем коде по §3.3–3.7                                                 |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `Start`                                                    | `goal start` → `goalActor(ctx)` → стор `helpers.json`, G1                        |
| `NormalizeDay`, `Due`                                      | `runHelperTick()`, нормализация дня и атомарный G2                               |
| `Claim`, `RecordSession`                                   | прежние T2/T3 помощников, `session.started`, `scripts/helpers/run.ts`            |
| `Report(v)`                                                | `goal report`, текущая сессия проверки, CAS G3                                   |
| `StopByDeadline`, `StopByCeiling`                          | процесс хода проверки, T5; `GOAL_CHECK_DEADLINE_MS`                              |
| `ProcessDies`, `ServerRestart`, `ConfirmEnd`               | конец хода/`no_active_turn`, T9/T7 помощников                                    |
| `Settle`                                                   | `finalize` строки и G5 одной записью, правила 0–4                                |
| `PauseByLimit`, `CreateNotice`                             | `runHelperTick()`, G2p/G2n; `owes` и конструктор извещения                       |
| `OwnerEdit`, `OwnerResume`, `OwnerNextCheck`, `OwnerClose` | `goalActor(ctx)`, G6/G6r/G6t/G8; ждущая строка финализируется в записи владельца |
| `WatchNudge`                                               | `goalActor(ctx)` для Watch, G6w                                                  |
| `Tell`                                                     | прежний `helper outcome`, `shown`/`delivered`, T14/T15                           |
| `PersistRead`, `PersistLast`, `PersistMark`, `PersistFail` | `runHelperTick()`, сохранение `last.md`, §3.4, шаг 1                             |
| `SweepRow`, `SweepGoal`                                    | `runHelperTick()`, уборка после `saved`, затем G9                                |
| `DayPasses`, `QuietOn`, `QuietOff`                         | часы/пояс владельца и `isQuietHour(config, hour)`                                |
| `HelperRowAdd`, `HelperRowDrop`, `Arrive`, `LimitReached`  | среда: занятость общей таблицы, наступление срока, расход и срок жизни           |

Слабая справедливость включения и выключения тихого часа и добавления/уборки
обычной строки заставляет эти события повторяться бесконечно; `DayPasses` также
слабо справедлив и всегда доступен.

Смерть HTTP-клиента оставляет серверный ход живым: серверный T3 и `Report`
могут завершиться после неё. Перезапуск завершает все старые серверные ходы,
включая ход с ещё отсутствующим id.

Предпосылки: проверенные захват и отмена помощника, конечное число отказов и
обрывов, справедливое завершение хода и рассказ (`HelperRun`, `HelperOutcome`).
Матрица `goalActor`, смешанные стороны сессии, данные на проводе, текст результата,
реальные миллисекунды, права файлов и поведение Telegram проверяются при реализации.
Модель абстрагирует отказ записи таблицы как шаг, сохраняющий всё состояние.
