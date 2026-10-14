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

`Check`, `SavePost`, `Recheck` and `Replace` are separate steps. The night rereads the Card after saving its answer to the day cache. Cooperating Iva writers share the Card lock; a direct owner save can occur between filesystem operations. `HumanPublishStable` explicitly assumes a stable file from the final reread through the atomic rename. With that assumption disabled, `NightWriter-publish-window.cfg` demonstrates the remaining direct-edit window; `NightWriter-save-window.cfg` demonstrates publication without the reread. `night-writer-check.sh` checks those witnesses and the positive `NightWriter.cfg`. Card drafts, pending facts, daily summaries and periods have separate executable tests.

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

## UpdateLock

`UpdateLock.tla` separates abandoned-owner inspection, rename, owner comparison,
restoration, mkdir and publication. `UpdateLock.cfg` and `UpdateLock-ownerless.cfg`
check two new contenders with recorded and missing owners. The ownerless model
distinguishes an old empty directory from the fresh `mkdir → owner.json` publication
window; `UpdateLock-ownerless-unsafe.cfg` shows two holders when null contents are
accepted without checking freshness. `UpdateLock-by-path.cfg`, `UpdateLock-mixed.cfg`
and `UpdateLock-three.cfg` retain witnesses for path deletion, legacy contenders
and a third contender in the restore window. Run `sh specs/update-lock-check.sh`.
Actual milliseconds, process liveness and crashes during displacement are covered
by executable tests and the accepted residual windows in `docs/tech-debt.md` §18.

## RestartRecovery

`RestartRecovery.cfg` checks restart, quarantine, failures, notification and queue
drain; `RestartRecovery-candidate.cfg` retains the earlier blocking behavior.
`RestartRecovery-window.cfg` checks scan, lock acquisition, reread and publication
against Bridge closing a turn or starting a new one. Publication uses the stored
reread snapshot. The chat lock holds `ClosedStaysClosed`; the generation comparison
holds `NewTurnKept` for a new turn started before acquisition.
`RestartRecovery-window-unsafe.cfg` removes the lock and must violate
`ClosedStaysClosed`. Run `sh specs/restart-recovery-check.sh`.
The two-second recovery stale threshold has the same short synchronous-section
assumption as `FileLock`; a stalled live writer exceeding it can lose its lock.

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

`HelperRun.tla` описывает узел конца по v7.2 §2 и §7: один писатель исхода —
минутный тик, durable-события ядра — среда. `cancel` доставляет команду и
сохраняет возможность продолжения ядра. `resetQueued` обозначает cancel/reset по известному id после
исхода; успех reset для finalize не требуется.

Граф состоит из claim, HTTP create, T3, событий ядра, смены owner/карантина,
close и последовательного прохода тика. Окончательный отказ HTTP даёт failed;
сеть/срок после отправки оставляет lost-id. Отказ T3 отправляет отмену и уборку
по известному локально id, затем делает failed по CAS. Конечный снимок либо
ошибка/срок/мусор/404 — отдельные ответы среды. Тик сначала использует первое
терминальное событие; затем смену owner с подтверждённой доставкой отмены либо
неизвестным id; затем первый stop по объёму/сроку; наконец безусловную границу
часов. При читаемом снимке сохраняется последний завершённый пригодный текст.

`Claim` разрешён в начальную минуту; время относительно firedAt нормализовано:
deadline=2, grace=1. `TickStart` фиксирует строки прохода, `TickRow` исполняет
одну строку, `TickDone` публикует завершённую минуту. Clock допускает следующий
проход после текущего. `BoundedEnd` требует исход у каждого claim после первого
завершённого прохода на deadline+grace; это Ф16 «граница + минута + один проход»,
а не безусловное eventual завершение ядра. Отдельное `NoSilentEnd` проверяется
под справедливостью Clock и действий тика помощников, независимо от хода напоминания.
`reminderBusy = TRUE` остаётся во всех состояниях: задача напоминаний может
ожидать бесконечно, а отдельное расписание `agent/schedules/helpers.ts`
продолжает исполнять тик. `shared-schedule` возвращает ожидание напоминания
и нарушает `NoSilentEnd` даже со справедливостью доступных действий. Справедливость End, успешного снимка,
доставки cancel, reset или появления событий не предполагается.

`TickRow` атомарно абстрагирует конечную последовательность HTTP-вызовов:
каждый возвращает ответ или достигает HELPER_CHECK_MS. Реальные 15 секунд,
замок/CAS при перекрытии двух проходов и порядок отдельных awaits проверяют
тесты реализации; их wall-clock время модель минутных проходов не измеряет.
Один слот относится к строкам таблицы: `OneRun` считает `run`, а не durable
сессии. Durable work после interrupted/границы/lost-id — принятое следствие;
`NoDetachedWork` даёт ожидаемый красный свидетель на обычной модели.

Свойства `HelperRun` читают состояние и независимую историю входов CAS:
`OutcomeOnce` — число commits; `StopOnce` — первый stop в журнале просьб;
`OutcomeJustified` — событие, отказ старта/T3, доставленная отмена при смене
owner или часы; `OutcomeMatches` — таблица исходов v7.2; `RestartDelivered` —
доставка перед interrupted при известном id; `PartialKept` и `WorkMeasured` —
текст и формула по данным снимка; `RowConsistent` — исход/claim. Имена мутантов
в свойствах отсутствуют. Мутанты меняют только переходы/запись результатов.
Bounds: один helper, в capacity — два; 0..4 минуты, две завершённые реплики,
две usage-записи, input 0..2/output 0..1, нормированный предел работы 3.
Порядок исходов, last string/null/дельты и реальные токены дополнительно держит
property-based проверка foldHelperSnapshot в продукте.

`HelperOutcome.tla` сохраняет прежний отдельный контракт чтения/пересказа:
несколько исходов, память полной пары session/turn у потребителя,
durable deliveredAt после непустого подтверждённого ответа, retention/visibility,
owner access и восстановление Bridge. NoTwoReads/NoRepeatedRead и потеря
offline-события — ожидаемые красные свидетели принятых последствий. Bounds:
две строки, две сессии, clock 0..2, KEEP=1, два чтения строки. Переписывание
свойств чтения по находкам FN4–FN5 ночи остаётся отдельной работой этой модели.

```sh
PATH=/opt/homebrew/opt/openjdk@25/bin:$PATH JAVA_TOOL_OPTIONS=-Xmx3g sh specs/helper-check.sh
```

Load <20 перед каждым cfg, workers 1..4, heap по умолчанию 3 GiB; BFS
seed 20261013/fingerprint 1. Simulation отделена от полного перебора.
Trap удаляет metadir/states; LOG_DIR сохраняет журналы и results.tsv.
Ожидаемый invariant отказ требует exit12 и точное имя; temporal отказ — exit13
и единственное свойство конфигурации. Инфраструктурная ошибка не убивает мутант.
Всего 38 конфигураций: 21 HelperRun (10 зелёных, 9 разных мутантов,
дополнительная temporal проверка «нет потолка», свидетель durable-хвоста)
и 17 прежних HelperOutcome. Все прогоны выполняются на Mac mini.

| Конфигурация                                                                   | Ожидаемый результат   |
| ------------------------------------------------------------------------------ | --------------------- |
| [HelperRun-v72-run.cfg](HelperRun-v72-run.cfg)                                 | PASS                  |
| [HelperRun-v72-silent.cfg](HelperRun-v72-silent.cfg)                           | PASS                  |
| [HelperRun-v72-restart.cfg](HelperRun-v72-restart.cfg)                         | PASS                  |
| [HelperRun-v72-quarantine.cfg](HelperRun-v72-quarantine.cfg)                   | PASS                  |
| [HelperRun-v72-cancel-failure.cfg](HelperRun-v72-cancel-failure.cfg)           | PASS                  |
| [HelperRun-v72-snapshot-failure.cfg](HelperRun-v72-snapshot-failure.cfg)       | PASS                  |
| [HelperRun-v72-lost-id.cfg](HelperRun-v72-lost-id.cfg)                         | PASS                  |
| [HelperRun-v72-record-failure.cfg](HelperRun-v72-record-failure.cfg)           | PASS                  |
| [HelperRun-v72-reminder-busy.cfg](HelperRun-v72-reminder-busy.cfg)             | PASS                  |
| [HelperRun-v72-capacity.cfg](HelperRun-v72-capacity.cfg)                       | PASS                  |
| [HelperRun-v72-cancel-finish.cfg](HelperRun-v72-cancel-finish.cfg)             | RED: OutcomeJustified |
| [HelperRun-v72-no-ceiling.cfg](HelperRun-v72-no-ceiling.cfg)                   | RED: BoundedEnd       |
| [HelperRun-v72-restart-undelivered.cfg](HelperRun-v72-restart-undelivered.cfg) | RED: RestartDelivered |
| [HelperRun-v72-finalize-twice.cfg](HelperRun-v72-finalize-twice.cfg)           | RED: OutcomeOnce      |
| [HelperRun-v72-stop-overwrite.cfg](HelperRun-v72-stop-overwrite.cfg)           | RED: StopOnce         |
| [HelperRun-v72-wrong-event.cfg](HelperRun-v72-wrong-event.cfg)                 | RED: OutcomeMatches   |
| [HelperRun-v72-drop-text.cfg](HelperRun-v72-drop-text.cfg)                     | RED: PartialKept      |
| [HelperRun-v72-work-output.cfg](HelperRun-v72-work-output.cfg)                 | RED: WorkMeasured     |
| [HelperRun-v72-no-ceiling-live.cfg](HelperRun-v72-no-ceiling-live.cfg)         | RED: NoSilentEnd      |
| [HelperRun-v72-shared-schedule.cfg](HelperRun-v72-shared-schedule.cfg)         | RED: NoSilentEnd      |
| [HelperRun-v72-detached-work.cfg](HelperRun-v72-detached-work.cfg)             | RED: NoDetachedWork   |

HelperOutcome: `-safety`, `-bridge-recovery` — PASS; остальные конфиги
проверяют прежние отрицательные свидетели, перечисленные в `helper-check.sh`.

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
| `Claim`, `RecordSession`                                   | T2/T3 помощников, HTTP create и запись sessionId в `helper-tick.ts`              |
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

HelperRun v7.2 заменяет клиентский цикл: Usage хранится в durable-снимке,
stop по объёму исполняет ближайший тик. Finish всегда исполняет тик и сохраняет
завершённый текст доступного снимка. Outcome Read сохраняет одно правило owner;
BridgeDown/BridgeUp сохраняют исход, доступный динамически, при потере события
о завершении offline. После подъёма новый исход получает событие: старый исход
автоматически не переигрывается (`HelperOutcome-bridge-recovery` — PASS,
`bridge-stays-down` — RED BridgeRecovered, `recovery-complete` — RED NoRecoveryComplete).
