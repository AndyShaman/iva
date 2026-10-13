---- MODULE HelperRun ----
\* Жизненный цикл строки Helper и её захвата (спека helpers/spec-v4.md v4.4, §3.5–§3.8,
\* §4 и §7). Модель написана ДО продуктового кода: она проверяет дизайн.
\*
\* Модель разделяет три факта, которые нельзя схлопывать:
\*   1. durable runToken в data/helpers.json занимает слот;
\*   2. клиентский процесс scripts/helpers/run.ts может оборваться на любом шаге;
\*   3. ход на сервере может ещё жить после ответа cancel = accepted.
\* Два элемента Servers — процессы eve до и после Restart. Restart завершает ходы старого
\* процесса, убивает его клиентов, но оставляет durable строки новому процессу для T9.
\*
\* CreateSession сразу начинает серверный ход. ServerRecordSession и ClientRecordSession
\* независимо пробуют T3, включая отказ записи и смерть клиента до onSession.
\* При T9 с sessionId=null серверный ход может остаться жить: unrecordedRelease
\* помечает ровно это исключение v4.4; ServerStep доводит его до предела ядра.
\* §3.7: хвост без записанного id временно может превысить capacity;
\* предел шагов ограничивает жизнь этого хвоста.
\* §7: WF(ServerStep) — предпосылка среды, сервер завершает шаг или отмену.
\* Вечное молчание удерживает известный слот и не входит в обещание NoSilentEnd.
\* cancel=accepted сохраняет run. NoActiveTurn подтверждает конец отдельно.
\*
\* Действие модели -> место в будущем коде:
\*   Add, ClosePending, CloseRunning, CloseFinished, Sweep
\*       agent/lib/helper-store.ts (T1, T11, T12, finalize)
\*   Claim, ClaimAgain, ChildStarted, ChildFailedToStart, Tick
\*       agent/lib/helper-tick.ts (T2, T2c, T2f, T9)
\*   CreateSession, ClientRecordSession, Stop,
\*   TurnEnds, PrepareFinish, CommitFinish, CrashProcess
\*       scripts/helpers/run.ts (клиент T3, T5, T7 и обрыв процесса)
\*   ServerRecordSession, ServerStep, NoActiveTurn
\*       серверный хук session.started (§3.8, сервер T3), eve/harness (Я3 и отмена)
\*   Restart
\*       два процесса сервера до/после systemd restart; первый тик нового процесса
\*
\* Переключатели свидетелей (TRUE — дизайн v4.4):
\*   FinalizeCAS  finalize проверяет outcome = null и тот же runToken. Без проверки
\*                сохранённый T7-коммит после T9 финализирует строку второй раз.
\*   ReapOrphans  тик обрабатывает умершего владельца/клиента. Без него run молча висит.
\*   OwnerClaimSafe
\*                T2 считает собственный уже существующий захват занятым. Мутант
\*                ClaimAgain трактует owner = me как разрешение повторного T2.
\*   EnforceLimit T2 считает все durable run. Без проверки берутся три слота при MaxRunning=1.
\*   WaitForEnd    cancel=accepted сохраняет слот. Без ожидания T9 финализирует при ещё
\*                живом canceling-ходе.

EXTENDS Naturals, FiniteSets, TLC

CONSTANTS
  Helpers, Servers, MaxRunning, DeadlineTicks, MaxClaims, MaxSteps,
  FinalizeCAS, ReapOrphans, OwnerClaimSafe, EnforceLimit, WaitForEnd, WaitClientEnd

ASSUME Cardinality(Helpers) \in {2, 3}
ASSUME Cardinality(Servers) = 2
ASSUME MaxRunning = 1
ASSUME DeadlineTicks \in Nat \ {0}
ASSUME MaxClaims \in Nat \ {0}
ASSUME MaxSteps \in Nat \ {0}
ASSUME {FinalizeCAS, ReapOrphans, OwnerClaimSafe, EnforceLimit, WaitForEnd, WaitClientEnd} \subseteq BOOLEAN

NoServer == "none"
Statuses == {"absent", "pending", "finished", "closed"}
ChildStates == {"none", "live", "dead"}
Phases == {"none", "spawned", "sent", "canceling", "ended"}
Stops == {"none", "deadline", "ceiling", "closed"}
Outcomes == {"none", "done", "failed", "deadline", "ceiling", "interrupted", "stopped"}
Tokens == 1..MaxClaims

VARIABLES
  added,
  status, runToken, runOwner, child, phase, stop, outcome, age,
  currentServer, serverAlive, restarts, nextToken,
  activeTokens, finishTickets,
  finalizeCount, stopCount, tickPulse,
  recorded, serverWriter, clientWriter, sessionServer, remoteSteps, unrecordedRelease

rowV == <<status, runToken, runOwner, child, phase, stop, outcome, age>>
serverV == <<currentServer, serverAlive, restarts, nextToken>>
ghostV == <<activeTokens, finishTickets, finalizeCount, stopCount, tickPulse>>
sessionV == <<recorded, serverWriter, clientWriter, sessionServer, remoteSteps, unrecordedRelease>>
vars == <<added, rowV, serverV, ghostV, sessionV>>

Running == {h \in Helpers : runToken[h] # 0}

TerminalOutcome(h, fallback) ==
  CASE stop[h] = "closed"   -> "stopped"
    [] stop[h] = "deadline" -> "deadline"
    [] stop[h] = "ceiling"  -> "ceiling"
    [] OTHER                 -> fallback

TerminalStatus(h) == IF stop[h] = "closed" THEN "closed" ELSE "finished"

BaseInit ==
  /\ added = FALSE
  /\ status = [h \in Helpers |-> "absent"]
  /\ runToken = [h \in Helpers |-> 0]
  /\ runOwner = [h \in Helpers |-> NoServer]
  /\ child = [h \in Helpers |-> "none"]
  /\ phase = [h \in Helpers |-> "none"]
  /\ stop = [h \in Helpers |-> "none"]
  /\ outcome = [h \in Helpers |-> "none"]
  /\ age = [h \in Helpers |-> 0]
  /\ LET s == CHOOSE q \in Servers : TRUE IN
       /\ currentServer = s
       /\ serverAlive = [q \in Servers |-> q = s]
  /\ restarts = 0
  /\ nextToken = 1
  /\ activeTokens = [h \in Helpers |-> {}]
  /\ finishTickets = [h \in Helpers |-> {}]
  /\ finalizeCount = [h \in Helpers |-> 0]
  /\ stopCount = [h \in Helpers |-> 0]
  /\ tickPulse = [h \in Helpers |-> FALSE]
  /\ recorded = [h \in Helpers |-> FALSE]
  /\ serverWriter = [h \in Helpers |-> "pending"]
  /\ clientWriter = [h \in Helpers |-> "pending"]
  /\ sessionServer = [h \in Helpers |-> NoServer]
  /\ remoteSteps = [h \in Helpers |-> 0]
  /\ unrecordedRelease = [h \in Helpers |-> FALSE]

\* T1: три строки становятся готовыми одновременно, как требует §7.
Add ==
  /\ ~added
  /\ added' = TRUE
  /\ status' = [h \in Helpers |-> "pending"]
  /\ UNCHANGED <<runToken, runOwner, child, phase, stop, outcome, age,
                  serverV, ghostV, sessionV>>

\* T2. ClaimAgain — только мутант -ownerme: ошибка «owner = me значит можно взять снова».
Claim(h) ==
  /\ added /\ status[h] = "pending" /\ outcome[h] = "none"
  /\ runToken[h] = 0
  /\ nextToken <= MaxClaims
  /\ (~EnforceLimit \/ Cardinality(Running) < MaxRunning)
  /\ runToken' = [runToken EXCEPT ![h] = nextToken]
  /\ runOwner' = [runOwner EXCEPT ![h] = currentServer]
  /\ child' = [child EXCEPT ![h] = "none"]
  /\ phase' = [phase EXCEPT ![h] = "none"]
  /\ age' = [age EXCEPT ![h] = 0]
  /\ activeTokens' = [activeTokens EXCEPT ![h] = @ \cup {nextToken}]
  /\ finishTickets' = [finishTickets EXCEPT ![h] = {}]
  /\ nextToken' = nextToken + 1
  /\ UNCHANGED <<added, status, stop, outcome, currentServer, serverAlive, restarts,
                  finalizeCount, stopCount, tickPulse, sessionV>>

ClaimAgain(h) ==
  /\ ~OwnerClaimSafe
  /\ status[h] = "pending" /\ outcome[h] = "none"
  /\ runToken[h] # 0 /\ runOwner[h] = currentServer
  /\ nextToken <= MaxClaims
  /\ runToken' = [runToken EXCEPT ![h] = nextToken]
  /\ runOwner' = [runOwner EXCEPT ![h] = currentServer]
  /\ child' = [child EXCEPT ![h] = "none"]
  /\ phase' = [phase EXCEPT ![h] = "none"]
  /\ age' = [age EXCEPT ![h] = 0]
  /\ activeTokens' = [activeTokens EXCEPT ![h] = @ \cup {nextToken}]
  /\ finishTickets' = [finishTickets EXCEPT ![h] = {}]
  /\ nextToken' = nextToken + 1
  /\ UNCHANGED <<added, status, stop, outcome, currentServer, serverAlive, restarts,
                  finalizeCount, stopCount, tickPulse, sessionV>>

\* T2c и T2f.
ChildStarted(h) ==
  /\ runToken[h] # 0 /\ child[h] = "none" /\ phase[h] = "none"
  /\ child' = [child EXCEPT ![h] = "live"]
  /\ phase' = [phase EXCEPT ![h] = "spawned"]
  /\ UNCHANGED <<added, status, runToken, runOwner, stop, outcome, age,
                  serverV, activeTokens, finishTickets, finalizeCount, stopCount, tickPulse, sessionV>>

ChildFailedToStart(h) ==
  /\ runToken[h] # 0 /\ child[h] = "none" /\ phase[h] = "none"
  /\ status' = [status EXCEPT ![h] = TerminalStatus(h)]
  /\ outcome' = [outcome EXCEPT ![h] = TerminalOutcome(h, "failed")]
  /\ runToken' = [runToken EXCEPT ![h] = 0]
  /\ runOwner' = [runOwner EXCEPT ![h] = NoServer]
  /\ child' = [child EXCEPT ![h] = "dead"]
  /\ phase' = [phase EXCEPT ![h] = "ended"]
  /\ activeTokens' = [activeTokens EXCEPT ![h] = @ \ {runToken[h]}]
  /\ finalizeCount' = [finalizeCount EXCEPT ![h] = @ + 1]
  /\ UNCHANGED <<added, stop, age, serverV, finishTickets, stopCount, tickPulse, sessionV>>

\* create(message) запускает ход немедленно; оба T3 остаются отдельными действиями.
CreateSession(h) ==
  /\ runToken[h] # 0 /\ child[h] = "live" /\ phase[h] = "spawned"
  /\ phase' = [phase EXCEPT ![h] = "sent"]
  /\ sessionServer' = [sessionServer EXCEPT ![h] = currentServer]
  /\ UNCHANGED <<added, status, runToken, runOwner, child, stop, outcome, age,
                  serverV, ghostV, recorded, serverWriter, clientWriter,
                  remoteSteps, unrecordedRelease>>

\* Сервер может записать id после смерти клиента. Отказ: ход продолжает работать.
ServerRecordSession(h) ==
  /\ phase[h] \in {"sent", "canceling", "ended"}
  /\ sessionServer[h] # NoServer /\ serverAlive[sessionServer[h]]
  /\ serverWriter[h] = "pending"
  /\ \E success \in BOOLEAN :
       /\ serverWriter' = [serverWriter EXCEPT ![h] = IF success THEN "ok" ELSE "failed"]
       /\ recorded' = [recorded EXCEPT ![h] = @ \/
                              (success /\ runToken[h] # 0 /\ outcome[h] = "none")]
  /\ UNCHANGED <<added, rowV, serverV, ghostV, clientWriter, sessionServer,
                  remoteSteps, unrecordedRelease>>

\* onSession живого клиента. Если обе записи отказали, запрос отмены идёт по id,
\* известному клиенту, хотя в таблицу id не попал; T7 дождётся конца (SPEC-FIX-2).
ClientRecordSession(h) ==
  /\ runToken[h] # 0 /\ child[h] = "live"
  /\ phase[h] \in {"sent", "ended"} /\ clientWriter[h] = "pending"
  /\ \E success \in BOOLEAN :
       /\ clientWriter' = [clientWriter EXCEPT ![h] = IF success THEN "ok"
                   ELSE IF recorded[h] THEN "redundant" ELSE "failed"]
       /\ recorded' = [recorded EXCEPT ![h] = @ \/ success]
       /\ IF ~success /\ ~recorded[h] /\ ~WaitClientEnd
            THEN /\ phase' = phase
                 /\ status' = [status EXCEPT ![h] = TerminalStatus(h)]
                 /\ outcome' = [outcome EXCEPT ![h] = TerminalOutcome(h, "failed")]
                 /\ runToken' = [runToken EXCEPT ![h] = 0]
                 /\ runOwner' = [runOwner EXCEPT ![h] = NoServer]
                 /\ child' = [child EXCEPT ![h] = "dead"]
                 /\ finalizeCount' = [finalizeCount EXCEPT ![h] = @ + 1]
            ELSE /\ phase' = [phase EXCEPT ![h] =
                        IF ~success /\ ~recorded[h] /\ @ = "sent" THEN "canceling" ELSE @]
                 /\ UNCHANGED <<status, outcome, runToken, runOwner, child, finalizeCount>>
  /\ UNCHANGED <<added, stop, age, serverV, activeTokens, finishTickets,
                  stopCount, tickPulse, serverWriter, sessionServer,
                  remoteSteps, unrecordedRelease>>

\* Конец сервера независим от жизни клиента и durable run, включая потерянный id.
TurnEnds(h) ==
  /\ phase[h] \in {"sent", "canceling"}
  /\ phase' = [phase EXCEPT ![h] = "ended"]
  /\ activeTokens' = [activeTokens EXCEPT ![h] = {}]
  /\ UNCHANGED <<added, status, runToken, runOwner, child, stop, outcome, age,
                  serverV, finishTickets, finalizeCount, stopCount, tickPulse, sessionV>>

\* Я3: даже ход с потерянным id ограничен числом шагов. Слабая справедливость
\* означает, что сервер/провайдер в конце концов завершает шаг или отмену.
ServerStep(h) ==
  /\ phase[h] \in {"sent", "canceling"}
  /\ IF remoteSteps[h] < MaxSteps
       THEN /\ remoteSteps' = [remoteSteps EXCEPT ![h] = @ + 1]
            /\ UNCHANGED <<phase, activeTokens>>
       ELSE /\ remoteSteps' = remoteSteps
            /\ phase' = [phase EXCEPT ![h] = "ended"]
            /\ activeTokens' = [activeTokens EXCEPT ![h] = {}]
  /\ UNCHANGED <<added, status, runToken, runOwner, child, stop, outcome, age,
                  serverV, finishTickets, finalizeCount, stopCount, tickPulse,
                  recorded, serverWriter, clientWriter, sessionServer, unrecordedRelease>>

\* T5 от срока/ceiling. CloseRunning ниже пишет ту же одноразовую причину closed.
Stop(h) ==
  /\ runToken[h] # 0 /\ outcome[h] = "none" /\ stop[h] = "none"
  /\ \E why \in {"deadline", "ceiling"} :
       /\ stop' = [stop EXCEPT ![h] = why]
  /\ stopCount' = [stopCount EXCEPT ![h] = @ + 1]
  /\ UNCHANGED <<added, status, runToken, runOwner, child, phase, outcome, age,
                  serverV, activeTokens, finishTickets, finalizeCount, tickPulse, sessionV>>

\* Процесс T7 читает конец и готовит коммит. Ticket хранит ожидаемый firedAt/runToken.
PrepareFinish(h) ==
  /\ runToken[h] # 0 /\ child[h] = "live" /\ phase[h] = "ended"
  /\ runToken[h] \notin finishTickets[h]
  /\ finishTickets' = [finishTickets EXCEPT ![h] = @ \cup {runToken[h]}]
  /\ UNCHANGED <<added, rowV, serverV, activeTokens, finalizeCount, stopCount, tickPulse, sessionV>>

CommitFinish(h, t) ==
  /\ t \in finishTickets[h]
  /\ (~FinalizeCAS \/ (runToken[h] = t /\ outcome[h] = "none"))
  /\ status' = [status EXCEPT ![h] = TerminalStatus(h)]
  /\ outcome' = [outcome EXCEPT ![h] = TerminalOutcome(h, IF clientWriter[h] = "failed"
                                      THEN "failed" ELSE "done")]
  /\ runToken' = [runToken EXCEPT ![h] = 0]
  /\ runOwner' = [runOwner EXCEPT ![h] = NoServer]
  /\ child' = [child EXCEPT ![h] = "dead"]
  /\ phase' = [phase EXCEPT ![h] = "ended"]
  /\ activeTokens' = [activeTokens EXCEPT ![h] = @ \ {t}]
  /\ finishTickets' = [finishTickets EXCEPT ![h] = @ \ {t}]
  /\ finalizeCount' = [finalizeCount EXCEPT ![h] = @ + 1]
  /\ UNCHANGED <<added, stop, age, serverV, stopCount, tickPulse, sessionV>>

\* Обрыв клиентского процесса возможен после spawn, до/после T3, после задания, отмены и конца.
CrashProcess(h) ==
  /\ runToken[h] # 0 /\ child[h] = "live"
  /\ child' = [child EXCEPT ![h] = "dead"]
  /\ UNCHANGED <<added, status, runToken, runOwner, phase, stop, outcome, age,
                  serverV, ghostV, sessionV>>

\* T11 против тика: pending закрывается сразу; running только пишет stop; готовая строка
\* становится closed, сохраняя свой outcome.
ClosePending(h) ==
  /\ status[h] = "pending" /\ runToken[h] = 0 /\ outcome[h] = "none"
  /\ status' = [status EXCEPT ![h] = "closed"]
  /\ stop' = [stop EXCEPT ![h] = "closed"]
  /\ outcome' = [outcome EXCEPT ![h] = "stopped"]
  /\ finalizeCount' = [finalizeCount EXCEPT ![h] = @ + 1]
  /\ stopCount' = [stopCount EXCEPT ![h] = @ + 1]
  /\ UNCHANGED <<added, runToken, runOwner, child, phase, age, serverV,
                  activeTokens, finishTickets, tickPulse, sessionV>>

CloseRunning(h) ==
  /\ status[h] = "pending" /\ runToken[h] # 0
  /\ outcome[h] = "none" /\ stop[h] = "none"
  /\ stop' = [stop EXCEPT ![h] = "closed"]
  /\ stopCount' = [stopCount EXCEPT ![h] = @ + 1]
  /\ UNCHANGED <<added, status, runToken, runOwner, child, phase, outcome, age,
                  serverV, activeTokens, finishTickets, finalizeCount, tickPulse, sessionV>>

CloseFinished(h) ==
  /\ status[h] = "finished" /\ outcome[h] # "none" /\ runToken[h] = 0
  /\ status' = [status EXCEPT ![h] = "closed"]
  /\ UNCHANGED <<added, runToken, runOwner, child, phase, stop, outcome, age,
                  serverV, ghostV, sessionV>>

\* T9. Cancel accepted и no_active_turn разделены; ошибки/тишина — пульс без
\* освобождения слота. При неизвестном id тик финализирует после убийства клиента,
\* а серверный ход продолжает идти до Я3 — названное исключение v4.4.
NoActiveTurn(h) ==
  /\ runToken[h] # 0 /\ phase[h] = "ended" /\ outcome[h] = "none"
  /\ (ReapOrphans \/ (child[h] # "dead" /\ serverAlive[runOwner[h]]))
  /\ status' = [status EXCEPT ![h] = TerminalStatus(h)]
  /\ outcome' = [outcome EXCEPT ![h] = TerminalOutcome(h,
                   IF age[h] = DeadlineTicks THEN "deadline"
                   ELSE IF ~serverAlive[runOwner[h]] \/ child[h] = "dead" THEN "interrupted"
                   ELSE IF clientWriter[h] = "failed" THEN "failed" ELSE "done")]
  /\ runToken' = [runToken EXCEPT ![h] = 0]
  /\ runOwner' = [runOwner EXCEPT ![h] = NoServer]
  /\ child' = [child EXCEPT ![h] = "dead"]
  /\ activeTokens' = [activeTokens EXCEPT ![h] = {}]
  /\ finalizeCount' = [finalizeCount EXCEPT ![h] = @ + 1]
  /\ UNCHANGED <<added, phase, stop, age, serverV, finishTickets, stopCount, tickPulse, sessionV>>

Tick(h) ==
  /\ runToken[h] # 0 /\ outcome[h] = "none"
  /\ LET orphan == ~serverAlive[runOwner[h]] \/ child[h] = "dead"
         mustStop == stop[h] # "none" \/ age[h] = DeadlineTicks \/ orphan
     IN
     \/ /\ orphan /\ ~ReapOrphans
        /\ tickPulse' = [tickPulse EXCEPT ![h] = ~@]
        /\ UNCHANGED <<added, rowV, serverV, activeTokens, finishTickets,
                        finalizeCount, stopCount, sessionV>>
     \/ /\ ~mustStop /\ phase[h] # "ended"
        /\ age' = [age EXCEPT ![h] = @ + 1]
        /\ UNCHANGED <<added, status, runToken, runOwner, child, phase, stop, outcome,
                        serverV, ghostV, sessionV>>
     \/ /\ mustStop /\ (~orphan \/ ReapOrphans)
        /\ phase[h] \in {"sent", "canceling"} /\ recorded[h]
        /\ IF WaitForEnd
             THEN /\ phase' = [phase EXCEPT ![h] = "canceling"]
                  /\ child' = [child EXCEPT ![h] = "dead"]
                  /\ tickPulse' = [tickPulse EXCEPT ![h] = ~@]
                  /\ UNCHANGED <<status, runToken, runOwner, outcome, finalizeCount>>
             ELSE /\ phase' = phase
                  /\ child' = [child EXCEPT ![h] = "dead"]
                  /\ status' = [status EXCEPT ![h] = TerminalStatus(h)]
                  /\ outcome' = [outcome EXCEPT ![h] = TerminalOutcome(h, "interrupted")]
                  /\ runToken' = [runToken EXCEPT ![h] = 0]
                  /\ runOwner' = [runOwner EXCEPT ![h] = NoServer]
                  /\ finalizeCount' = [finalizeCount EXCEPT ![h] = @ + 1]
                  /\ UNCHANGED tickPulse
        /\ UNCHANGED <<added, stop, age, serverV, activeTokens, finishTickets,
                        stopCount, sessionV>>
     \/ /\ mustStop /\ (~orphan \/ ReapOrphans) /\ ~recorded[h]
        /\ status' = [status EXCEPT ![h] = TerminalStatus(h)]
        /\ outcome' = [outcome EXCEPT ![h] = TerminalOutcome(h,
                                   IF age[h] = DeadlineTicks THEN "deadline" ELSE "interrupted")]
        /\ runToken' = [runToken EXCEPT ![h] = 0]
        /\ runOwner' = [runOwner EXCEPT ![h] = NoServer]
        /\ child' = [child EXCEPT ![h] = "dead"]
        /\ unrecordedRelease' = [unrecordedRelease EXCEPT ![h] =
                                       phase[h] \in {"sent", "canceling"}]
        /\ activeTokens' = [activeTokens EXCEPT ![h] =
                            IF phase[h] \in {"sent", "canceling"} THEN @ ELSE {}]
        /\ finalizeCount' = [finalizeCount EXCEPT ![h] = @ + 1]
        /\ UNCHANGED <<added, phase, stop, age, serverV, finishTickets, stopCount,
                        tickPulse, recorded, serverWriter, clientWriter, sessionServer, remoteSteps>>
     \/ /\ NoActiveTurn(h)

\* Второй сервер после restart. Сессии первого процесса уже не активны; durable run остаётся
\* до T9, поэтому слот не переиспользуется раньше подтверждённого конца.
Restart ==
  /\ restarts = 0
  /\ \E s \in Servers \ {currentServer} :
       /\ currentServer' = s
       /\ serverAlive' = [q \in Servers |-> q = s]
  /\ restarts' = 1
  /\ child' = [h \in Helpers |->
                  IF runToken[h] # 0 /\ runOwner[h] = currentServer THEN "dead" ELSE child[h]]
  /\ phase' = [h \in Helpers |->
                  IF sessionServer[h] = currentServer
                     /\ phase[h] \in {"sent", "canceling"}
                    THEN "ended"
                    ELSE phase[h]]
  /\ activeTokens' = [h \in Helpers |->
                         IF sessionServer[h] = currentServer \/ runOwner[h] = currentServer
                           THEN {}
                           ELSE activeTokens[h]]
  /\ UNCHANGED <<added, status, runToken, runOwner, stop, outcome, age, nextToken,
                  finishTickets, finalizeCount, stopCount, tickPulse, sessionV>>

\* T12. Ghost-счётчики остаются, чтобы удаление строки не стирало доказательство.
Sweep(h) ==
  /\ status[h] = "closed" /\ runToken[h] = 0
  /\ status' = [status EXCEPT ![h] = "absent"]
  /\ UNCHANGED <<added, runToken, runOwner, child, phase, stop, outcome, age,
                  serverV, ghostV, sessionV>>

BaseNext ==
  \/ Add \/ Restart
  \/ \E h \in Helpers :
       \/ Claim(h) \/ ClaimAgain(h) \/ ChildStarted(h) \/ ChildFailedToStart(h)
       \/ CreateSession(h) \/ ServerRecordSession(h) \/ ClientRecordSession(h) \/ ServerStep(h)
       \/ TurnEnds(h) \/ Stop(h) \/ PrepareFinish(h) \/ CrashProcess(h)
       \/ ClosePending(h) \/ CloseRunning(h) \/ CloseFinished(h) \/ Tick(h) \/ Sweep(h)
       \/ \E t \in Tokens : CommitFinish(h, t)

VARIABLE v6
CONSTANTS V6Case, V6Mutant
Init == BaseInit /\ v6 = "legacy"
Next == BaseNext /\ UNCHANGED v6

Spec == Init /\ [][Next]_vars /\ \A h \in Helpers :
  (WF_vars(Tick(h)) /\ WF_vars(ServerStep(h)))

TypeOK ==
  /\ added \in BOOLEAN
  /\ status \in [Helpers -> Statuses]
  /\ runToken \in [Helpers -> 0..MaxClaims]
  /\ runOwner \in [Helpers -> Servers \cup {NoServer}]
  /\ child \in [Helpers -> ChildStates]
  /\ phase \in [Helpers -> Phases]
  /\ stop \in [Helpers -> Stops]
  /\ outcome \in [Helpers -> Outcomes]
  /\ age \in [Helpers -> 0..DeadlineTicks]
  /\ currentServer \in Servers
  /\ serverAlive \in [Servers -> BOOLEAN]
  /\ restarts \in 0..1
  /\ nextToken \in 1..(MaxClaims + 1)
  /\ activeTokens \in [Helpers -> SUBSET Tokens]
  /\ finishTickets \in [Helpers -> SUBSET Tokens]
  /\ finalizeCount \in [Helpers -> Nat]
  /\ stopCount \in [Helpers -> Nat]
  /\ tickPulse \in [Helpers -> BOOLEAN]
  /\ recorded \in [Helpers -> BOOLEAN]
  /\ serverWriter \in [Helpers -> {"pending", "ok", "failed"}]
  /\ clientWriter \in [Helpers -> {"pending", "ok", "failed", "redundant"}]
  /\ sessionServer \in [Helpers -> Servers \cup {NoServer}]
  /\ remoteSteps \in [Helpers -> 0..MaxSteps]
  /\ unrecordedRelease \in [Helpers -> BOOLEAN]

\* У одной строки не бывает двух реально начатых попыток.
OneRun == \A h \in Helpers : Cardinality(activeTokens[h]) <= 1

\* Durable slots считаются до T9/T7 finalize, включая отмену accepted.
WithinLimits == Cardinality(Running) <= MaxRunning

\* CAS finalize и одноразовый stop.
OutcomeOnce == \A h \in Helpers : finalizeCount[h] <= 1
StopOnce == \A h \in Helpers : stopCount[h] <= 1

\* closed — терминальная строка: исход есть, durable slot уже освобождён.
ClosedFinal ==
  \A h \in Helpers : status[h] = "closed" => (outcome[h] # "none" /\ runToken[h] = 0)

\* Исключение v4.4: T9 не знает id, клиент убит, остаточный серверный ход
\* ограничен Я3 и CAS запрещает ему писать исход. Известный id исключения не даёт.
SlotFreedAfterEnd ==
  \A h \in Helpers : runToken[h] = 0 =>
    (activeTokens[h] = {} \/
      (unrecordedRelease[h] /\ ~recorded[h] /\ child[h] = "dead" /\ outcome[h] # "none"))

\* Reachability witness: этот ложный инвариант обязан дать короткую трассу исключения.
NoUnrecordedTail ==
  \A h \in Helpers : ~(unrecordedRelease[h] /\ phase[h] \in {"sent", "canceling"}
                           /\ serverWriter[h] = "failed" /\ clientWriter[h] = "pending"
                           /\ outcome[h] = "interrupted")

NoBothWriters ==
  \A h \in Helpers : ~(serverWriter[h] = "ok" /\ clientWriter[h] = "ok")

NoServerOnly ==
  \A h \in Helpers : ~(serverWriter[h] = "ok" /\ clientWriter[h] = "pending"
                           /\ child[h] = "dead" /\ recorded[h]
                           /\ phase[h] = "sent" /\ runToken[h] # 0)

UnrecordedTailEnds ==
  \A h \in Helpers : unrecordedRelease[h] ~> phase[h] = "ended"

\* При справедливом тике и продвижении сервера любой взятый run получает исход. finalizeCount — ghost,
\* который переживает T12 и делает свойство наблюдаемым после удаления строки.
NoSilentEnd ==
  \A h \in Helpers : (runToken[h] # 0) ~> (finalizeCount[h] > 0)

\* Helpers have no priority; permute only their identities in safety BFS.
HelperSymmetry == Permutations(Helpers)

FullView == vars

\* Main VIEW: после окончательного исхода и конца сервера нет нового claim этой
\* строки. Поздний T3 тогда лишь меняет диагностический флаг; CAS не даёт записи.
\* Схлопываем только такие завершённые метаданные, сохраняя status/outcome,
\* наличие исхода, счётчики safety и unrecordedRelease. Вид готового исхода
\* влияет далее только через outcome != none; повторного finalize с CAS нет. Активный хвост сохраняет ВСЕ поля.
\* tickPulse не влияет на enabled действий; его self-loop остаётся ребром Tick.
\* T3 writer labels after pending only select final outcome kinds; recorded and
\* phase retain all write/cancel effects. Deadline and ceiling have identical
\* enabled actions and terminal status; closed stays separate. These projections
\* preserve every main invariant and both temporal predicates.
\* Мутанты и reachability-свидетели используют FullView.
Settled(h) == outcome[h] # "none" /\ runToken[h] = 0 /\ activeTokens[h] = {}
View == <<added, serverV,
  [h \in Helpers |-> <<status[h], outcome[h] # "none", runToken[h], activeTokens[h],
    finalizeCount[h], stopCount[h], unrecordedRelease[h],
    IF Settled(h) THEN <<>> ELSE <<runOwner[h], child[h], phase[h],
      IF stop[h] \in {"deadline", "ceiling"} THEN "stopped" ELSE stop[h], age[h],
      finishTickets[h], recorded[h], serverWriter[h] = "pending", clientWriter[h] = "pending",
      sessionServer[h], remoteSteps[h]>> >>] >>

\* v6.0: bounded extension of the lifecycle. Legacy Spec remains a regression
\* graph; V6Spec uses the same module with an explicit physical/durable split.
\* Old variables are initialized and frozen, not projected into the new graph.
\* Each case selects an initial condition and relevant interference, not a new
\* product mechanism. May is opaque: no interpretation of its words here.
V6Actors == {"owner", "helper", "service", "group", "unknown"}
V6Mays == {"missing", "wrong-type", "oversize", "empty", "opaque"}
V6Allowed(a) == a = "owner"
V6ValidMay(m) == m \in {"empty", "opaque"}
V6RVars == <<vars, v6>>
V6Init ==
  /\ BaseInit
  /\ v6 = [row |-> IF V6Case = "auth" THEN "absent" ELSE "pending",
       slot |-> FALSE, token |-> 0, physical |-> "none", pid |-> FALSE,
       clientKnows |-> FALSE, durableId |-> FALSE, writerTried |-> FALSE,
       remote |-> "none", question |-> FALSE, waiting |-> FALSE,
       stop |-> "none", outcome |-> "none", finalized |-> 0,
       stopCount |-> 0, lostId |-> FALSE, may |-> "opaque", taskMay |-> "none",
       written |-> FALSE, summary |-> FALSE, read |-> FALSE,
       now |-> 0, finishedAt |-> 0, sweptEarly |-> FALSE,
       rejectedChanged |-> FALSE, invalidMay |-> FALSE,
       ownerAlive |-> TRUE, ownerIdentitySame |-> TRUE,
       killedUnknown |-> FALSE, killedStale |-> FALSE, pidReused |-> FALSE,
       changedClosedOutcome |-> FALSE,
       effect |-> "none", attempts |-> 0, accepted |-> 0,
       lostResponse |-> FALSE, lateEffect |-> FALSE, tailEffect |-> FALSE]

V6Add(a, m) ==
  /\ v6.row = "absent"
  /\ (V6Allowed(a) /\ V6ValidMay(m))
      \/ (V6Mutant = "helper-start" /\ a = "helper")
      \/ (V6Mutant = "may" /\ ~V6ValidMay(m) /\ V6Allowed(a))
  /\ v6' = [v6 EXCEPT !.row = "pending", !.may = m,
       !.rejectedChanged = ~V6Allowed(a), !.invalidMay = ~V6ValidMay(m)]

V6Claim ==
  /\ v6.row = "pending" /\ ~v6.slot /\ v6.outcome = "none"
  /\ v6' = [v6 EXCEPT !.slot = TRUE, !.token = 1]
V6Spawn ==
  /\ v6.slot /\ v6.physical = "none"
  /\ v6' = [v6 EXCEPT !.physical = "live"]
V6RecordPid ==
  /\ v6.slot /\ v6.physical = "live" /\ ~v6.writerTried
  /\ \E ok \in BOOLEAN :
       v6' = [v6 EXCEPT !.writerTried = TRUE, !.pid = ok]
V6Create ==
  /\ v6.physical = "live" /\ v6.remote = "none" /\ v6.slot
  /\ v6' = [v6 EXCEPT !.remote = "live", !.clientKnows = TRUE,
       !.taskMay = IF V6Mutant = "may-copy" THEN "changed" ELSE v6.may]
V6RecordSession ==
  /\ v6.slot /\ v6.remote = "live" /\ ~v6.durableId
  /\ v6' = [v6 EXCEPT !.durableId = TRUE]
V6Close(a) ==
  /\ v6.row \in {"pending", "finished"} /\ v6.stop = "none"
  /\ V6Allowed(a)
  /\ v6' = [v6 EXCEPT !.stop = "closed", !.stopCount = @ + 1,
       !.rejectedChanged = ~V6Allowed(a),
       !.row = IF v6.outcome # "none" THEN "closed" ELSE @,
       !.outcome = IF v6.outcome # "none" /\ V6Mutant = "close-outcome" THEN "stopped" ELSE @,
       !.changedClosedOutcome = v6.outcome # "none" /\ V6Mutant = "close-outcome"]
V6Question ==
  /\ v6.slot /\ v6.remote = "live" /\ ~v6.question
  /\ v6' = [v6 EXCEPT !.question = TRUE, !.remote = "canceling"]
V6Write ==
  /\ v6.physical = "live" /\ v6.remote \in {"live", "canceling"}
  /\ v6.stop = "none" /\ ~v6.question
  /\ ~v6.written
  /\ v6' = [v6 EXCEPT !.written = TRUE]
V6Crash ==
  /\ v6.physical = "live"
  /\ v6' = [v6 EXCEPT !.physical = "dead"]
V6CancelAccepted ==
  /\ v6.slot /\ (v6.stop = "closed" \/ v6.question)
  /\ v6.remote = "live" /\ (v6.clientKnows \/ v6.durableId)
  /\ v6' = [v6 EXCEPT !.remote = "canceling",
       !.slot = IF V6Mutant = "early-free" THEN FALSE ELSE @]
\* Without durable pid the tick cannot pretend the physical child is dead.
\* A live onSession client knows its id and must wait even when both T3 fail.
V6KillKnownChild ==
  /\ v6.slot /\ v6.stop = "closed" /\ (v6.physical = "live" \/ v6.pidReused)
  /\ v6.pid \/ V6Mutant = "pid"
  /\ (v6.ownerAlive /\ v6.ownerIdentitySame) \/ V6Mutant = "owner-kill"
  /\ v6' = [v6 EXCEPT !.physical = "dead",
       !.killedUnknown = ~v6.pid,
       !.killedStale = ~(v6.ownerAlive /\ v6.ownerIdentitySame)]
V6OwnerRestart ==
  /\ v6.ownerAlive /\ v6.slot
  /\ v6' = [v6 EXCEPT !.ownerAlive = FALSE, !.ownerIdentitySame = FALSE,
       !.physical = "dead"]
\* The persisted number may now refer to an unrelated process. It is never
\* a target of SIGKILL; remote cancellation still works through durableId.
V6PidReused ==
  /\ ~v6.ownerAlive /\ v6.physical = "dead" /\ v6.pid /\ ~v6.pidReused
  /\ v6' = [v6 EXCEPT !.pidReused = TRUE]
V6ServerEnd ==
  /\ v6.remote \in {"live", "canceling"}
  /\ v6' = [v6 EXCEPT !.remote = "ended", !.waiting = ~v6.question]
V6Terminal ==
  CASE v6.stop = "closed" -> "stopped"
    [] v6.question /\ V6Mutant # "question" -> "failed"
    [] v6.remote = "ended" -> "done"
    [] OTHER -> "interrupted"
V6Finalize ==
  /\ v6.slot /\ v6.outcome = "none"
  /\ v6.remote = "ended"
      \/ (v6.physical = "dead" /\ ~v6.durableId)
  /\ v6' = [v6 EXCEPT !.slot = FALSE, !.outcome = V6Terminal,
       !.row = IF v6.stop = "closed" THEN "closed" ELSE "finished",
       !.finishedAt = v6.now, !.finalized = @ + 1,
       !.lostId = v6.remote \in {"live", "canceling"},
       !.summary = IF V6Mutant = "partial" THEN FALSE ELSE v6.written]
V6Clock ==
  /\ v6.now < 2
  /\ v6' = [v6 EXCEPT !.now = @ + 1]
V6Sweep ==
  /\ v6.row = "closed" /\ ~v6.slot
  /\ v6.now >= v6.finishedAt + 1 \/ V6Mutant = "sweep"
  /\ v6' = [v6 EXCEPT !.row = "absent",
       !.sweptEarly = v6.now < v6.finishedAt + 1]
V6ReadClosed ==
  /\ v6.row = "closed" /\ v6.outcome # "none"
  /\ V6Mutant # "read"
  /\ v6' = [v6 EXCEPT !.read = TRUE]
\* Ordinary helper effects are permitted; effects follow the instruction.
V6Attempt ==
  /\ v6.remote \in {"live", "canceling"} /\ v6.attempts < 2
  /\ v6.effect \in {"none", "unknown"}
  /\ v6' = [v6 EXCEPT !.effect = "inflight", !.attempts = @ + 1]
V6EffectEnd ==
  /\ v6.effect = "inflight"
  /\ \E result \in {"accepted", "unknown", "partial"} :
       v6' = [v6 EXCEPT !.effect = result,
         !.accepted = IF result \in {"accepted", "unknown"} THEN @ + 1 ELSE @,
         !.lostResponse = @ \/ result = "unknown",
         !.lateEffect = @ \/ v6.stop = "closed",
         !.tailEffect = @ \/ v6.lostId]

V6Lifecycle ==
  \/ V6Claim \/ V6Spawn \/ V6RecordPid \/ V6Create \/ V6RecordSession
  \/ V6ServerEnd \/ V6Finalize \/ V6Crash
  \/ /\ V6Case = "owner" /\ (V6OwnerRestart \/ V6PidReused)
  \/ V6Close("owner") \/ V6CancelAccepted \/ V6KillKnownChild
  \/ V6Write \/ V6Clock \/ V6Sweep \/ V6ReadClosed
  \/ /\ V6Case = "question" /\ V6Question
  \/ /\ V6Case = "effects" /\ (V6Attempt \/ V6EffectEnd)
V6Next ==
  /\ IF V6Case = "auth" THEN
       \E a \in V6Actors :
         (\E m \in V6Mays : V6Add(a, m)) \/ V6Close(a)
     ELSE V6Lifecycle
  /\ UNCHANGED vars
V6Spec == V6Init /\ [][V6Next]_V6RVars
             /\ WF_V6RVars(V6Spawn /\ UNCHANGED vars)
             /\ WF_V6RVars(V6Create /\ UNCHANGED vars)
             /\ WF_V6RVars(V6ServerEnd /\ UNCHANGED vars)
             /\ WF_V6RVars(V6Finalize /\ UNCHANGED vars)
V6TypeOK ==
  /\ v6.row \in {"absent", "pending", "finished", "closed"}
  /\ v6.physical \in {"none", "live", "dead"}
  /\ v6.remote \in {"none", "live", "canceling", "ended"}
  /\ v6.outcome \in {"none", "done", "failed", "stopped", "interrupted"}
  /\ v6.now \in 0..2 /\ v6.finishedAt \in 0..2
  /\ v6.attempts \in 0..2 /\ v6.accepted <= v6.attempts
V6Authorized == ~v6.rejectedChanged
V6PidKnown == ~v6.killedUnknown
V6OwnerKillSafe == ~v6.killedStale
V6MayRequired == ~v6.invalidMay
V6MayUnchanged == v6.taskMay = "none" \/ v6.taskMay = v6.may
V6OutcomeOnce == v6.finalized <= 1
V6StopOnce == v6.stopCount <= 1
V6ClosedFinal == v6.row = "closed" => ~v6.slot /\ v6.outcome # "none"
V6SlotFreedAfterEnd == ~v6.slot =>
  v6.remote \notin {"live", "canceling"} \/ (v6.lostId /\ v6.physical = "dead" /\ ~v6.durableId)
V6QuestionFailed == v6.question /\ v6.outcome # "none" /\ v6.stop = "none" => v6.outcome = "failed"
V6PartialKept == v6.written /\ v6.outcome # "none" => v6.summary
V6KeepClosed == ~v6.sweptEarly
V6CloseKeepsOutcome == ~v6.changedClosedOutcome
V6ClosedReadable == v6.row = "closed" /\ v6.outcome # "none" =>
  ENABLED (V6ReadClosed /\ UNCHANGED vars)
V6NoSilentEnd == v6.slot ~> v6.outcome # "none"
V6TailEnds == v6.lostId ~> v6.remote = "ended"
\* Reachability witnesses below MUST fail: these are accepted risks, not safety.
V6NoLateEffect == ~v6.lateEffect
V6NoDuplicateEffect == v6.accepted <= 1
V6NoTailEffect == ~v6.tailEffect
V6NoNormalWaiting == ~v6.waiting
V6NoUnrecordedCreate == v6.remote # "live" \/ v6.pid
V6NoCloseInFlight == ~(v6.stop = "closed" /\ v6.effect = "inflight")
====
