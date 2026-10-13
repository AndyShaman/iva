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

HelperRun.tla и HelperOutcome.tla проверяют v6.4. Run: CAS/первый stop, один слот,
клиентский create→recordSession, owner epoch, отмена до подтверждённого конца,
lost-id исключение, отказ клиентской записи, существующий runner timeout, partial последнего сообщения,
close/read/KEEP, auth/may. Общие auth/Trace и applyTurnEvent равны базе.

Outcome: finish-once, чистое чтение нескольких исходов, память полной пары
session/turn у потребителя, durable deliveredAt после подтверждённого непустого
ответа, retention/visibility. Две сессии имеют turn_0; Restart стирает read marker.
NoTwoReads/NoRepeatedRead — ожидаемые красные свидетели принятых последствий.

Единственный Run граф без VIEW/legacy. Bounds: один helper (capacity — два),
capacity=1, clock 0..3, две завершённые реплики/действия. Outcome: две строки,
две сессии, clock 0..2, KEEP=1, два чтения строки. Шаговый предел 2 и объём работы 3
проверяются Run с формулой положительного прироста входа плюс выход;
MAX_OPEN/MAX_ROWS проверяются продуктовым PBT. FairSpec требует fair Clock/Cancel/End/
RunnerTimeout/T9/CeilingStop; вечная тишина держит слот. Late/duplicate effect и lost-id tail
имеют достижимые свидетели; качество пересказа остаётся решением модели.
Удалены все прежние HelperRun cfg, в том числе dual writer/child pid/kill mutant;
оставшиеся контракты и мутанты имеют префикс HelperRun-v64-.

```sh
PATH=/opt/homebrew/opt/openjdk@25/bin:$PATH JAVA_TOOL_OPTIONS=-Xmx3g sh specs/helper-check.sh
```

Load <20 перед каждым cfg, workers 1..4, BFS seed 20261013/fingerprint 1;
simulation seed 20261011 отделён от BFS. Trap очищает metadir/states.
Ожидаемая invariant ошибка — exit12 и точное имя; temporal witness — exit13.
Инфраструктурная ошибка красного мутанта не доказывает. LOG_DIR хранит результаты.
Проверки идут на Mac mini с Node24 и OpenJDK25.

| Конфигурация                                                             | Ожидаемый результат      |
| ------------------------------------------------------------------------ | ------------------------ |
| [HelperRun-v64-auth.cfg](HelperRun-v64-auth.cfg)                         | PASS                     |
| [HelperRun-v64-capacity.cfg](HelperRun-v64-capacity.cfg)                 | PASS                     |
| [HelperRun-v64-run.cfg](HelperRun-v64-run.cfg)                           | PASS                     |
| [HelperRun-v64-effects.cfg](HelperRun-v64-effects.cfg)                   | PASS                     |
| [HelperRun-v64-live.cfg](HelperRun-v64-live.cfg)                         | PASS                     |
| [HelperRun-v64-helper-start.cfg](HelperRun-v64-helper-start.cfg)         | RED: Authorized          |
| [HelperRun-v64-may.cfg](HelperRun-v64-may.cfg)                           | RED: MayRequired         |
| [HelperRun-v64-may-copy.cfg](HelperRun-v64-may-copy.cfg)                 | RED: MayUnchanged        |
| [HelperRun-v64-no-capacity.cfg](HelperRun-v64-no-capacity.cfg)           | RED: OneRun              |
| [HelperRun-v64-finalize-twice.cfg](HelperRun-v64-finalize-twice.cfg)     | RED: OutcomeOnce         |
| [HelperRun-v64-stale-cas.cfg](HelperRun-v64-stale-cas.cfg)               | RED: SlotFreedAfterEnd   |
| [HelperRun-v64-step-limit.cfg](HelperRun-v64-step-limit.cfg)             | RED: WithinLimits        |
| [HelperRun-v64-work-output.cfg](HelperRun-v64-work-output.cfg)           | RED: WorkMeasured        |
| [HelperRun-v64-work-stop.cfg](HelperRun-v64-work-stop.cfg)               | RED: WorkStops           |
| [HelperRun-v64-stop-twice.cfg](HelperRun-v64-stop-twice.cfg)             | RED: StopOnce            |
| [HelperRun-v64-question-done.cfg](HelperRun-v64-question-done.cfg)       | RED: QuestionFailed      |
| [HelperRun-v64-early-free.cfg](HelperRun-v64-early-free.cfg)             | RED: SlotFreedAfterEnd   |
| [HelperRun-v64-partial.cfg](HelperRun-v64-partial.cfg)                   | RED: PartialKept         |
| [HelperRun-v64-sweep.cfg](HelperRun-v64-sweep.cfg)                       | RED: KeepClosed          |
| [HelperRun-v64-read.cfg](HelperRun-v64-read.cfg)                         | RED: ClosedReadable      |
| [HelperRun-v64-close-outcome.cfg](HelperRun-v64-close-outcome.cfg)       | RED: CloseKeepsOutcome   |
| [HelperRun-v64-late-effect.cfg](HelperRun-v64-late-effect.cfg)           | RED: NoLateEffect        |
| [HelperRun-v64-duplicate-effect.cfg](HelperRun-v64-duplicate-effect.cfg) | RED: NoDuplicateEffect   |
| [HelperRun-v64-tail-effect.cfg](HelperRun-v64-tail-effect.cfg)           | RED: NoTailEffect        |
| [HelperRun-v64-normal-waiting.cfg](HelperRun-v64-normal-waiting.cfg)     | RED: NoNormalWaiting     |
| [HelperRun-v64-live-nofair.cfg](HelperRun-v64-live-nofair.cfg)           | RED: NoSilentEnd         |
| [HelperRun-v64-restart-effect.cfg](HelperRun-v64-restart-effect.cfg)     | RED: NoRestartEffect     |
| [HelperOutcome-safety.cfg](HelperOutcome-safety.cfg)                     | PASS                     |
| [HelperOutcome-finish-twice.cfg](HelperOutcome-finish-twice.cfg)         | RED: OutcomeOnce         |
| [HelperOutcome-before-reply.cfg](HelperOutcome-before-reply.cfg)         | RED: DeliveredAfterReply |
| [HelperOutcome-empty-reply.cfg](HelperOutcome-empty-reply.cfg)           | RED: DeliveredAfterReply |
| [HelperOutcome-without-read.cfg](HelperOutcome-without-read.cfg)         | RED: DeliveredAfterReply |
| [HelperOutcome-turn-only.cfg](HelperOutcome-turn-only.cfg)               | RED: DeliveredAfterReply |
| [HelperOutcome-lose-unread.cfg](HelperOutcome-lose-unread.cfg)           | RED: UndeliveredKept     |
| [HelperOutcome-hide-unread.cfg](HelperOutcome-hide-unread.cfg)           | RED: Visible             |
| [HelperOutcome-early-close.cfg](HelperOutcome-early-close.cfg)           | RED: ClosedKept          |
| [HelperOutcome-read-write.cfg](HelperOutcome-read-write.cfg)             | RED: ReadPure            |
| [HelperOutcome-multiple.cfg](HelperOutcome-multiple.cfg)                 | RED: NoTwoReads          |
| [HelperOutcome-restart.cfg](HelperOutcome-restart.cfg)                   | RED: NoRepeatedRead      |

## GoalCheck

`GoalCheck.tla` проверяет дизайн поручения, которое помощник проверяет по расписанию
(Goal v3.2, §3.2–3.7, §4 и §7). `helpers.json` меняется атомарно под замком.
Два клиента сохранения моделируют чтение `last.md`, сравнение `finishedAt`,
переименование файла и отметку `saved` под тем же замком таблицы; G9 удаляет каталог
под этим же замком. Владелец может поправить или
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

Три SPEC-FIX приняты в спеке v3.2; конфигурации с ожидаемым контрпримером
сохраняют свидетелей прежних ошибок:

1. **SPEC-FIX-1, `-spec-file-race`:** чтение и сравнение вне замка таблицы позволяют
   старому писателю переименовать файл после нового. Решение §3.4, шаг 1:
   чтение заголовка, сравнение, переименование `last.md` и отметка `saved`
   идут под замком таблицы `helpers.json`. G9 берёт тот же замок при удалении
   каталога. `SerializeLast = TRUE` моделирует принятую сериализацию.
2. **SPEC-FIX-2, `-spec-weak-fair`:** слабая справедливость тика допускает
   повторяющиеся нетихие окна, в каждом из которых захват пропущен. Смена дня
   также делает нормализацию доступной периодически; WF позволяет откладывать
   эти действия. Предпосылка живости: повторяющиеся возможности
   нормализации дня и захвата обслуживаются — `SF_vars(NormalizeDay(g))`
   и `SF_vars(Due(g))`; так же обслуживаются извещения и вход в сохранение строки. `Due` нормализует день под тем же
   замком, как требует §3.3. Это уточнение предпосылки среды.
3. **SPEC-FIX-3, `-fail-default`:** правило 4 §3.4 сохраняет `nextCheckAtMs`
   и `ownerNext`: срок по умолчанию от захвата либо срок владельца из G6t.
   Буквальная формула `Settle ∧ ownerNext ∧ status′ = active ⇒ due′ = owner`
   действует для всех правил. Мутант `fail-default` назначает срок по умолчанию
   поверх срока владельца при сбое и нарушает `OwnerNextKept`.

Каждый из 16 свидетелей §7 имеет собственную конфигурацию: `-norev`, `-noclosed`,
`-owner-time`, `-fail-default`, `-doublecheck`, `-split`, `-pending-close`, `-require-done`,
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

Helpers v6.4: Usage и CeilingStop — отдельные операции. Естественный конец может выиграть гонку с запросом stop: done сохраняет весь итог, объём превышается на один шаг (HelperRun-v64-ceiling-race, RED NoCeilingRace). Finish(tick) сохраняет 0 текста; PartialKept относится к клиентскому концу, TickRetainsText — ожидаемый красный свидетель. Outcome Read допускает только owner, unknown/helper отвергаются (foreign-read — RED AuthorizedReads). BridgeDown/BridgeUp сохраняют исход без события: offline-event — RED OfflineEvent, Visible остаётся зелёным.

| Проверка v6.4                                                      | Результат            |
| ------------------------------------------------------------------ | -------------------- |
| [HelperRun-v64-ceiling-race.cfg](HelperRun-v64-ceiling-race.cfg)   | RED: NoCeilingRace   |
| [HelperRun-v64-tick-partial.cfg](HelperRun-v64-tick-partial.cfg)   | RED: TickRetainsText |
| [HelperOutcome-foreign-read.cfg](HelperOutcome-foreign-read.cfg)   | RED: AuthorizedReads |
| [HelperOutcome-offline-event.cfg](HelperOutcome-offline-event.cfg) | RED: OfflineEvent    |

Bounds Usage: input 0..3 (effects 0..2), output 0..1. CeilingStop может проиграть естественному концу. Helper-check выполняет 46 ожидаемых проверок.

BridgeUp возвращает мост в online. HelperOutcome-bridge-recovery проходит сценарий: старый исход a заканчивается offline и остаётся без события, после подъёма новый исход b получает событие. bridge-stays-down — RED BridgeRecovered; recovery-complete — RED NoRecoveryComplete, свидетель достижения нового события при сохранённом старом исходе.
