---- MODULE HelperOutcome ----
\* Доставка Outcome в основной разговор (helpers/spec-v4.md v4.4, §3.6 T13–T17,
\* §3.10, §4 и §7). Модель написана ДО продуктового кода: она проверяет дизайн.
\*
\* Один чат, две строки одного чата. Init допускает running и finished для каждой строки,
\* поэтому исследует в том числе требуемое состояние «оба исхода готовы одновременно»;
\* HelperFinished — внешний конец ещё идущей строки. Политика чата выбирается в Init из
\* queue («Очередь») и steer («Перебивать»), поэтому один основной cfg проверяет обе.
\*
\* Durable факты: rowState, wakeId/wakeSent/wakes, acceptedIds, shown, deliveredTurn.
\* envelopes — содержимое ответов инструмента в контексте модели; T14 его НЕ проверяет.
\* shownByTurn/deliveredByTurn — наблюдатели истории, НЕ память первого id сервера.
\* SPEC-FIX-3 отклонён: контракт — OneDeliveredPerTurn. T12 удаляет строку
\* по обычным условиям; факт активности хода для уборки не требуется.
\* После первого финального Outbox ответ может продолжиться вторым с тем же
\* turnId. Оба T15 независимы, Close/T12 и сбои допустимы между ними.
\* Финальный текст уже сформирован: T14 доступен до начала его отправки.
\* Volatile факты Bridge: reply. Текущий ход сервера: chat/turnId/turnPhase/envelopes.
\* Telegram side effect и T15 разделены: turnPhase = outbox означает, что непустой ответ уже
\* принят Telegram, но delivered ещё не записан. Любой выход из этого окна отмечает
\* lostMarkEver и разрешает повторный пересказ по гарантии «не меньше одного раза».
\*
\* Действие модели -> место в будущем коде:
\*   HelperFinished, Close, Sweep
\*       agent/lib/helper-store.ts (T7, T11, T12)
\*   AllocWake, SendWake, StampWake, LoseBridgeReply, BridgeCrash, BridgeStep
\*       scripts/poller/helper-wake.ts + scripts/poller/main.ts (T13, T16)
\*   ReadOutcome, ReadSecondOutcome
\*       agent/lib/helper-tool.ts (T14, один Outcome на Turn)
\*   OutboxFull, SecondOutbox, ResponseWithoutRead, OutboxFailure, PartialSend,
\*   MarkDelivered, T15WriteFailure
\*       agent/channels/telegram.ts + agent/lib/outbox.ts (message.completed, T15)
\*   EndTurn
\*       сервер turn.completed, освобождение чата после финального ответа
\*   OwnerMessage, CancelTurn, FailTurn, NewConversation
\*       scripts/poller/routing.ts + scripts/poller/control.ts
\*   ServerCrash
\*       eve/server restart; durable таблица и acceptance-ledger переживают процесс
\*
\* BridgeStep — исправный путь и единственное справедливое действие: выделить номер, подать
\* будильник только в свободный чат, записать T16, прочитать один исход, успешно отправить и
\* записать T15. Все отказы и вмешательства имеют общий конечный счётчик failures.
\*
\* Переключатели свидетелей: обычные TRUE, RecordClosed=FALSE — v4.4.
\* OneOutcomePerTurn — только исторический диагностический свидетель.
\*   RespectBusy       будильник подаётся только в свободный чат с пустой очередью;
\*   UniqueWakeIds     T13 берёт id из durable wakeSeq, а не арифметикой строки;
\*   RequireShown      T15 требует shown.turnId и успешный непустой Outbox;
\*   KeepUndelivered   T12 хранит finished без delivered до явного Close.
\*   RecordClosed      TRUE возвращает запись shown у closed из v4.3.

EXTENDS Naturals, FiniteSets

CONSTANTS
  N, MaxWake, MaxTurns, MaxFailures, MaxOwnerMessages, MaxNews, EscalateWakes,
  RespectBusy, UniqueWakeIds, RequireShown, KeepUndelivered, RecordClosed, StampCAS

\* Запас включает N доставок и до N закрытий после finished-чтения: такой ход
\* может не доставить готовую цель будильника. Ещё MaxFailures id покрывают сбои.
ASSUME N = 2
ASSUME MaxWake = 2 * N + MaxFailures
ASSUME MaxTurns >= 2 * N + MaxFailures + MaxOwnerMessages
ASSUME MaxFailures \in Nat
ASSUME MaxOwnerMessages \in Nat
ASSUME MaxNews \in Nat
ASSUME EscalateWakes \in Nat \ {0}
ASSUME {RespectBusy, UniqueWakeIds, RequireShown, KeepUndelivered, RecordClosed, StampCAS} \subseteq BOOLEAN

Rows == 1..N
WakeIds == 1..MaxWake
Turns == 1..MaxTurns
Policies == {"queue", "steer"}
RowStates == {"running", "finished", "closed", "deleted"}
Chats == {"free", "wake", "owner"}
TurnPhases == {"none", "active", "outbox", "between"}
Replies == {"none", "turn", "handled"}

VARIABLES
  rowState, deliveredTurn, shown, escalated,
  wakeId, wakeSent, wakes, stamped, wakeSeq, allocCount, acceptedIds,
  chat, turnId, turnRow, turnPhase, envelopes,
  reply, replyRow, replyWake, ownerQueued, policy, conversation, nextTurn,
  failures, ownerMessages, news, bridgeRestarts, serverRestarts,
  shownByTurn, deliveredByTurn, outboxByTurn, outboxParts, markedParts, toldCount, lostMarkEver, secondTried,
  wakeWhileBusy, wakeCollision, doubleStamp, lostUndelivered

rowV == <<rowState, deliveredTurn, shown, escalated>>
wakeV == <<wakeId, wakeSent, wakes, stamped, wakeSeq, allocCount, acceptedIds>>
turnV == <<chat, turnId, turnRow, turnPhase, envelopes,
           reply, replyRow, replyWake, ownerQueued, policy, conversation, nextTurn>>
countV == <<failures, ownerMessages, news, bridgeRestarts, serverRestarts>>
historyV == <<shownByTurn, deliveredByTurn, outboxByTurn, outboxParts, markedParts, toldCount, lostMarkEver, secondTried>>
ghostV == <<wakeWhileBusy, wakeCollision, doubleStamp, lostUndelivered>>
vars == <<rowV, wakeV, turnV, countV, historyV, ghostV>>

ReadyRows == {r \in Rows : rowState[r] = "finished" /\ deliveredTurn[r] = 0}
OldestReady == CHOOSE r \in ReadyRows : \A q \in ReadyRows : r <= q
ShownRows == {r \in Rows : rowState[r] = "finished" /\ deliveredTurn[r] = 0 /\ shown[r] = turnId}

Init ==
  /\ rowState \in [Rows -> {"running", "finished"}]
  /\ deliveredTurn = [r \in Rows |-> 0]
  /\ shown = [r \in Rows |-> 0]
  /\ escalated = [r \in Rows |-> FALSE]
  /\ wakeId = [r \in Rows |-> 0]
  /\ wakeSent = [r \in Rows |-> FALSE]
  /\ wakes = [r \in Rows |-> 0]
  /\ stamped = [r \in Rows |-> {}]
  /\ wakeSeq = 0
  /\ allocCount = [w \in WakeIds |-> 0]
  /\ acceptedIds = {}
  /\ chat = "free" /\ turnId = 0 /\ turnRow = 0
  /\ turnPhase = "none" /\ envelopes = {}
  /\ reply = "none" /\ replyRow = 0 /\ replyWake = 0
  /\ ownerQueued = FALSE
  /\ policy \in Policies
  /\ conversation = 0 /\ nextTurn = 1
  /\ failures = 0 /\ ownerMessages = 0 /\ news = 0
  /\ bridgeRestarts = 0 /\ serverRestarts = 0
  /\ shownByTurn = [t \in Turns |-> {}]
  /\ deliveredByTurn = [t \in Turns |-> {}]
  /\ outboxByTurn = [t \in Turns |-> FALSE]
  /\ outboxParts = [t \in Turns |-> 0]
  /\ markedParts = [t \in Turns |-> 0]
  /\ toldCount = [r \in Rows |-> 0]
  /\ lostMarkEver = [r \in Rows |-> FALSE]
  /\ secondTried = [t \in Turns |-> FALSE]
  /\ wakeWhileBusy = FALSE /\ wakeCollision = FALSE
  /\ doubleStamp = FALSE /\ lostUndelivered = FALSE

\* Конец помощника: две такие строки одного чата могут стать ready до первого BridgeStep.
HelperFinished(r) ==
  /\ rowState[r] = "running"
  /\ rowState' = [rowState EXCEPT ![r] = "finished"]
  /\ UNCHANGED <<deliveredTurn, shown, wakeV, turnV, countV, historyV, ghostV, escalated>>

\* T13. В мутанте arithmetic-id обе строки/попытки получают абстрактный id 1: это
\* минимальный bounded-свидетель коллизии формулы из прежней спеки.
AllocWake(r) ==
  /\ r \in ReadyRows /\ r = OldestReady
  /\ chat = "free" /\ ~ownerQueued /\ reply = "none"
  /\ (wakeId[r] = 0 \/ wakeSent[r])
  /\ wakeSeq < MaxWake
  /\ LET w == IF UniqueWakeIds THEN wakeSeq + 1 ELSE 1 IN
       /\ wakeId' = [wakeId EXCEPT ![r] = w]
       /\ wakeSent' = [wakeSent EXCEPT ![r] = FALSE]
       /\ wakeSeq' = wakeSeq + 1
       /\ allocCount' = [allocCount EXCEPT ![w] = @ + 1]
       /\ wakeCollision' = (wakeCollision \/ allocCount[w] > 0)
  /\ UNCHANGED <<rowV, wakes, stamped, acceptedIds, turnV, countV, historyV,
                  wakeWhileBusy, doubleStamp, lostUndelivered>>

\* Подача будильника. Если durable acceptance-ledger уже знает id, сервер отвечает handled.
\* Иначе начинается новый Turn. durable=FALSE моделирует известное отдельное окно: сервер
\* начал ход, но запись приёма update_id не легла.
SendWake(r) ==
  /\ r \in ReadyRows /\ wakeId[r] # 0 /\ ~wakeSent[r]
  /\ (~RespectBusy \/ (chat = "free" /\ ~ownerQueued)) /\ reply = "none"
  /\ IF wakeId[r] \in acceptedIds
       THEN /\ reply' = "handled" /\ replyRow' = r /\ replyWake' = wakeId[r]
            /\ UNCHANGED <<chat, turnId, turnRow, turnPhase, envelopes, nextTurn, acceptedIds, escalated>>
       ELSE /\ nextTurn <= MaxTurns
            /\ \E durable \in BOOLEAN :
                 /\ chat' = "wake" /\ turnId' = nextTurn /\ turnRow' = r
                 /\ turnPhase' = "active" /\ envelopes' = {}
                 /\ reply' = "turn" /\ replyRow' = r /\ replyWake' = wakeId[r]
                 /\ nextTurn' = nextTurn + 1
                 /\ acceptedIds' = IF durable THEN acceptedIds \cup {wakeId[r]}
                                                ELSE acceptedIds
  /\ wakeWhileBusy' = (wakeWhileBusy \/ (chat # "free" \/ ownerQueued))
  /\ UNCHANGED <<rowV, wakeId, wakeSent, wakes, stamped, wakeSeq, allocCount,
                  ownerQueued, policy, conversation, countV, historyV, wakeCollision, doubleStamp, lostUndelivered>>

\* T17: порог абстрагирован одной неудачей (в продукте шесть). Пометка
\* переживает /new и restart, дальнейшие будильники продолжают идти.
Escalate(r) ==
  /\ r \in ReadyRows /\ wakes[r] >= EscalateWakes /\ ~escalated[r]
  /\ escalated' = [escalated EXCEPT ![r] = TRUE]
  /\ UNCHANGED <<rowState, deliveredTurn, shown, wakeV, turnV, countV, historyV, ghostV>>

\* T16. Повторная квитанция того же id идемпотентна и wakes не увеличивает.
StampWake ==
  /\ reply \in {"turn", "handled"}
  /\ replyRow \in Rows /\ replyWake \in WakeIds
  /\ LET fresh == ~StampCAS \/ (wakeId[replyRow] = replyWake /\ ~wakeSent[replyRow]) IN
       /\ wakeSent' = IF wakeId[replyRow] = replyWake
                         THEN [wakeSent EXCEPT ![replyRow] = TRUE]
                         ELSE wakeSent
       /\ stamped' = [stamped EXCEPT ![replyRow] = @ \cup {replyWake}]
       /\ wakes' = [wakes EXCEPT ![replyRow] = @ + (IF fresh THEN 1 ELSE 0)]
       /\ doubleStamp' = (doubleStamp \/ (~fresh /\ wakes'[replyRow] # wakes[replyRow]))
  /\ reply' = "none" /\ replyRow' = 0 /\ replyWake' = 0
  /\ UNCHANGED <<rowV, wakeId, wakeSeq, allocCount, acceptedIds,
                  chat, turnId, turnRow, turnPhase, envelopes, ownerQueued, policy,
                  conversation, nextTurn, countV, historyV,
                  wakeWhileBusy, wakeCollision, lostUndelivered>>

\* Повторная квитанция старого принятого номера. Один такой транспортный сбой
\* входит в общий конечный бюджет; T16 сохраняет счётчик при wake.sent=true.
ReplayReceipt(r) ==
  /\ reply = "none" /\ wakeId[r] \in stamped[r] /\ failures < MaxFailures
  /\ reply' = "handled" /\ replyRow' = r /\ replyWake' = wakeId[r]
  /\ failures' = failures + 1
  /\ UNCHANGED <<rowV, wakeV, chat, turnId, turnRow, turnPhase, envelopes,
                  ownerQueued, policy, conversation, nextTurn,
                  ownerMessages, news, bridgeRestarts, serverRestarts, historyV, ghostV>>

\* Потеря ответа сервер -> Bridge: T16 не пишется, тот же id остаётся для повтора.
LoseBridgeReply ==
  /\ reply # "none" /\ failures < MaxFailures
  /\ reply' = "none" /\ replyRow' = 0 /\ replyWake' = 0
  /\ failures' = failures + 1
  /\ UNCHANGED <<rowV, wakeV, chat, turnId, turnRow, turnPhase, envelopes,
                  ownerQueued, policy, conversation, nextTurn,
                  ownerMessages, news, bridgeRestarts, serverRestarts,
                  historyV, ghostV>>

\* Падение Bridge отличается только потерей volatile reply; durable row/wake остаются.
BridgeCrash ==
  /\ reply # "none" /\ failures < MaxFailures
  /\ reply' = "none" /\ replyRow' = 0 /\ replyWake' = 0
  /\ failures' = failures + 1 /\ bridgeRestarts' = bridgeRestarts + 1
  /\ UNCHANGED <<rowV, wakeV, chat, turnId, turnRow, turnPhase, envelopes,
                  ownerQueued, policy, conversation, nextTurn,
                  ownerMessages, news, serverRestarts, historyV, ghostV>>

\* T14 v4.4: closed возвращает конверт без shown, finished проверяет только таблицу.
\* RecordClosed=TRUE возвращает прежний дефект v4.3 для отдельного свидетеля.
ReadOutcome(r) ==
  /\ chat \in {"wake", "owner"} /\ turnPhase = "active"
  /\ rowState[r] \in {"finished", "closed"} /\ deliveredTurn[r] = 0
  /\ LET needsShown == rowState[r] = "finished" \/ RecordClosed IN
       /\ (~needsShown \/ \A q \in Rows \ {r} : shown[q] # turnId)
       /\ shown' = IF needsShown THEN [shown EXCEPT ![r] = turnId] ELSE shown
       /\ shownByTurn' = IF needsShown
                            THEN [shownByTurn EXCEPT ![turnId] = @ \cup {r}]
                            ELSE shownByTurn
  /\ envelopes' = envelopes \cup {r}
  /\ UNCHANGED <<rowState, deliveredTurn, wakeV,
                  chat, turnId, turnRow, turnPhase, reply, replyRow, replyWake,
                  ownerQueued, policy, conversation, nextTurn,
                  countV, deliveredByTurn, outboxByTurn, outboxParts, markedParts, toldCount, lostMarkEver, secondTried, ghostV, escalated>>

\* Отказ второму finished id определяется существующими shown, включая закрытую
\* ПОСЛЕ чтения строку: T14 говорит «ни у одной другой строки».
ReadSecondOutcome(r) ==
  /\ chat \in {"wake", "owner"} /\ turnPhase = "active"
  /\ rowState[r] = "finished" /\ deliveredTurn[r] = 0
  /\ \E q \in Rows \ {r} : shown[q] = turnId
  /\ ~secondTried[turnId]
  /\ secondTried' = [secondTried EXCEPT ![turnId] = TRUE]
  /\ UNCHANGED <<rowV, wakeV, turnV, countV,
                  shownByTurn, deliveredByTurn, outboxByTurn, outboxParts, markedParts, toldCount, lostMarkEver, ghostV>>

\* Успешный непустой ответ уже имеет Telegram side effect; T15 ещё впереди.
\* Wake-ответ только о closed, без чтения finished, — тот же конечный класс отказа,
\* что ResponseWithoutRead. После бюджета исправный ход читает готовый исход.
OutboxFull ==
  /\ chat \in {"wake", "owner"} /\ turnPhase = "active" /\ envelopes # {}
  /\ (chat = "owner" \/ turnRow \notin ReadyRows \/ shownByTurn[turnId] # {} \/ failures < MaxFailures)
  /\ failures' = failures + (IF chat = "wake" /\ turnRow \in ReadyRows /\ shownByTurn[turnId] = {} THEN 1 ELSE 0)
  /\ turnPhase' = "outbox"
  /\ outboxParts' = [outboxParts EXCEPT ![turnId] = @ + 1]
  /\ outboxByTurn' = [outboxByTurn EXCEPT ![turnId] = TRUE]
  /\ toldCount' = [r \in Rows |-> toldCount[r] + (IF r \in shownByTurn[turnId] THEN 1 ELSE 0)]
  /\ UNCHANGED <<rowV, wakeV, chat, turnId, turnRow, envelopes,
                  reply, replyRow, replyWake, ownerQueued, policy, conversation, nextTurn,
                  ownerMessages, news, bridgeRestarts, serverRestarts, shownByTurn, deliveredByTurn, markedParts, lostMarkEver, secondTried, ghostV>>

\* T15 после shown и Outbox. Мутант -noshown отмечает ответ без чтения ниже.
MarkDelivered ==
  /\ chat \in {"wake", "owner"} /\ turnPhase = "outbox" /\ envelopes # {}
  /\ outboxByTurn[turnId]
  /\ deliveredTurn' = [r \in Rows |-> IF r \in ShownRows THEN turnId ELSE deliveredTurn[r]]
  /\ deliveredByTurn' = [deliveredByTurn EXCEPT ![turnId] = @ \cup ShownRows]
  /\ markedParts' = [markedParts EXCEPT ![turnId] = @ + 1]
  /\ turnPhase' = "between"
  /\ UNCHANGED <<rowState, shown, wakeV, chat, turnId, turnRow, envelopes, reply, replyRow, replyWake, ownerQueued, policy, conversation, nextTurn,
                  countV, shownByTurn, outboxByTurn, outboxParts, toldCount, lostMarkEver, secondTried, ghostV, escalated>>

\* Второй финальный Outbox — продолжение уже сформированного ответа того же Turn.
\* toldCount считает целостный пересказ, поэтому продолжение не создаёт новый пересказ.
SecondOutbox ==
  /\ chat \in {"wake", "owner"} /\ turnPhase = "between"
  /\ outboxParts[turnId] = 1 /\ markedParts[turnId] = 1
  /\ outboxParts' = [outboxParts EXCEPT ![turnId] = 2]
  /\ turnPhase' = "outbox"
  /\ UNCHANGED <<rowV, wakeV, chat, turnId, turnRow, envelopes,
                  reply, replyRow, replyWake, ownerQueued, policy, conversation, nextTurn,
                  countV, shownByTurn, deliveredByTurn, outboxByTurn, markedParts,
                  toldCount, lostMarkEver, secondTried, ghostV>>

\* Отдельное завершение Turn после одного или двух T15. Шов — turn.completed.
EndTurn ==
  /\ chat \in {"wake", "owner"} /\ turnPhase = "between"
  /\ chat' = "free" /\ turnId' = 0 /\ turnRow' = 0
  /\ turnPhase' = "none" /\ envelopes' = {}
  /\ reply' = "none" /\ replyRow' = 0 /\ replyWake' = 0
  /\ UNCHANGED <<rowV, wakeV, ownerQueued, policy, conversation, nextTurn,
                  countV, historyV, ghostV>>

\* Ответ без helper outcome: непустой ответ может уйти, но ни одна строка не получает T15.
ResponseWithoutRead ==
  /\ chat = "wake" /\ turnPhase = "active" /\ envelopes = {}
  /\ failures < MaxFailures
  /\ deliveredTurn' = IF RequireShown THEN deliveredTurn
                           ELSE [deliveredTurn EXCEPT ![turnRow] = turnId]
  /\ outboxByTurn' = [outboxByTurn EXCEPT ![turnId] = TRUE]
  /\ chat' = "free" /\ turnId' = 0 /\ turnRow' = 0
  /\ turnPhase' = "none" /\ envelopes' = {}
  /\ reply' = "none" /\ replyRow' = 0 /\ replyWake' = 0
  /\ failures' = failures + 1
  /\ UNCHANGED <<rowState, shown, wakeV, ownerQueued, policy, conversation, nextTurn,
                  ownerMessages, news, bridgeRestarts, serverRestarts,
                  shownByTurn, deliveredByTurn, outboxParts, markedParts, toldCount, lostMarkEver, secondTried, ghostV, escalated>>

\* Отказ Outbox до side effect.
OutboxFailure ==
  /\ chat \in {"wake", "owner"} /\ turnPhase = "active" /\ envelopes # {}
  /\ failures < MaxFailures
  /\ chat' = "free" /\ turnId' = 0 /\ turnRow' = 0
  /\ turnPhase' = "none" /\ envelopes' = {}
  /\ reply' = "none" /\ replyRow' = 0 /\ replyWake' = 0
  /\ failures' = failures + 1
  /\ UNCHANGED <<rowV, wakeV, ownerQueued, policy, conversation, nextTurn,
                  ownerMessages, news, bridgeRestarts, serverRestarts, historyV, ghostV>>

\* Telegram принял часть ответа: side effect есть, result.ok ложь, T15 нет.
PartialSend ==
  /\ chat \in {"wake", "owner"} /\ turnPhase = "active" /\ envelopes # {}
  /\ failures < MaxFailures
  /\ toldCount' = [r \in Rows |-> toldCount[r] + (IF r \in shownByTurn[turnId] THEN 1 ELSE 0)]
  /\ lostMarkEver' = [r \in Rows |-> lostMarkEver[r] \/ r \in shownByTurn[turnId]]
  /\ chat' = "free" /\ turnId' = 0 /\ turnRow' = 0
  /\ turnPhase' = "none" /\ envelopes' = {}
  /\ reply' = "none" /\ replyRow' = 0 /\ replyWake' = 0
  /\ failures' = failures + 1
  /\ UNCHANGED <<rowV, wakeV, ownerQueued, policy, conversation, nextTurn,
                  ownerMessages, news, bridgeRestarts, serverRestarts,
                  shownByTurn, deliveredByTurn, outboxByTurn, outboxParts, markedParts, secondTried, ghostV>>

\* Отказ записи T15 после полного принятого ответа.
T15WriteFailure ==
  /\ chat \in {"wake", "owner"} /\ turnPhase = "outbox" /\ envelopes # {}
  /\ failures < MaxFailures
  /\ lostMarkEver' = [r \in Rows |-> lostMarkEver[r] \/ r \in shownByTurn[turnId]]
  /\ chat' = "free" /\ turnId' = 0 /\ turnRow' = 0
  /\ turnPhase' = "none" /\ envelopes' = {}
  /\ reply' = "none" /\ replyRow' = 0 /\ replyWake' = 0
  /\ failures' = failures + 1
  /\ UNCHANGED <<rowV, wakeV, ownerQueued, policy, conversation, nextTurn,
                  ownerMessages, news, bridgeRestarts, serverRestarts,
                  shownByTurn, deliveredByTurn, outboxByTurn, outboxParts, markedParts, toldCount, secondTried, ghostV>>

\* Сообщение владельца посреди хода-будильника. queue сохраняет ход и ставит сообщение
\* следом; steer отменяет ход и сразу начинает Turn владельца. Если Outbox уже успел, окно
\* до T15 честно разрешает будущий дубль.
OwnerMessage ==
  /\ ownerMessages < MaxOwnerMessages
  /\ IF chat = "wake"
       THEN IF policy = "queue"
              THEN /\ ownerQueued' = TRUE
                   /\ ownerMessages' = ownerMessages + 1
                   /\ UNCHANGED <<chat, turnId, turnRow, turnPhase, envelopes,
                                   reply, replyRow, replyWake, nextTurn, failures, lostMarkEver, escalated>>
              ELSE /\ failures < MaxFailures /\ nextTurn <= MaxTurns
                   /\ lostMarkEver' =
                        IF turnPhase = "outbox" /\ envelopes # {}
                          THEN [r \in Rows |-> lostMarkEver[r] \/ r \in shownByTurn[turnId]]
                          ELSE lostMarkEver
                   /\ chat' = "owner" /\ turnId' = nextTurn /\ turnRow' = 0
                   /\ turnPhase' = "active" /\ envelopes' = {}
                   /\ reply' = "none" /\ replyRow' = 0 /\ replyWake' = 0
                   /\ ownerQueued' = FALSE /\ nextTurn' = nextTurn + 1
                   /\ ownerMessages' = ownerMessages + 1 /\ failures' = failures + 1
       ELSE /\ chat = "free" /\ ~ownerQueued /\ nextTurn <= MaxTurns
            /\ chat' = "owner" /\ turnId' = nextTurn /\ turnRow' = 0
            /\ turnPhase' = "active" /\ envelopes' = {}
            /\ reply' = "none" /\ replyRow' = 0 /\ replyWake' = 0
            /\ nextTurn' = nextTurn + 1 /\ ownerMessages' = ownerMessages + 1
            /\ UNCHANGED <<ownerQueued, failures, lostMarkEver, escalated>>
  /\ UNCHANGED <<rowV, wakeV, policy, conversation, news, bridgeRestarts, serverRestarts,
                  shownByTurn, deliveredByTurn, outboxByTurn, outboxParts, markedParts, toldCount, secondTried, ghostV>>

\* Явная отмена/сбой Turn. При side effect без T15 отмечается разрешённое окно дубля.
CancelTurn ==
  /\ chat = "wake" /\ failures < MaxFailures
  /\ lostMarkEver' =
       IF turnPhase = "outbox" /\ envelopes # {}
         THEN [r \in Rows |-> lostMarkEver[r] \/ r \in shownByTurn[turnId]]
         ELSE lostMarkEver
  /\ chat' = "free" /\ turnId' = 0 /\ turnRow' = 0
  /\ turnPhase' = "none" /\ envelopes' = {}
  /\ reply' = "none" /\ replyRow' = 0 /\ replyWake' = 0
  /\ failures' = failures + 1
  /\ UNCHANGED <<rowV, wakeV, ownerQueued, policy, conversation, nextTurn,
                  ownerMessages, news, bridgeRestarts, serverRestarts,
                  shownByTurn, deliveredByTurn, outboxByTurn, outboxParts, markedParts, toldCount, secondTried, ghostV>>

FailTurn == CancelTurn

\* Server crash завершает текущий Turn; durable таблица, T16 и acceptance-ledger остаются.
ServerCrash ==
  /\ chat \in {"wake", "owner"} /\ failures < MaxFailures
  /\ lostMarkEver' =
       IF turnPhase = "outbox" /\ envelopes # {}
         THEN [r \in Rows |-> lostMarkEver[r] \/ r \in shownByTurn[turnId]]
         ELSE lostMarkEver
  /\ chat' = "free" /\ turnId' = 0 /\ turnRow' = 0
  /\ turnPhase' = "none" /\ envelopes' = {}
  /\ reply' = "none" /\ replyRow' = 0 /\ replyWake' = 0
  /\ failures' = failures + 1 /\ serverRestarts' = serverRestarts + 1
  /\ UNCHANGED <<rowV, wakeV, ownerQueued, policy, conversation, nextTurn,
                  ownerMessages, news, bridgeRestarts,
                  shownByTurn, deliveredByTurn, outboxByTurn, outboxParts, markedParts, toldCount, secondTried, ghostV>>

\* /new меняет разговор и чистит обычную очередь; строки Outcome и номера будильников
\* остаются. Если команда пришла посреди Turn, тот Turn кончается без T15.
NewConversation ==
  /\ news < MaxNews
  /\ (chat = "free" \/ failures < MaxFailures)
  /\ lostMarkEver' =
       IF turnPhase = "outbox" /\ envelopes # {}
         THEN [r \in Rows |-> lostMarkEver[r] \/ r \in shownByTurn[turnId]]
         ELSE lostMarkEver
  /\ conversation' = conversation + 1 /\ news' = news + 1
  /\ failures' = failures + (IF chat = "free" THEN 0 ELSE 1)
  /\ chat' = "free" /\ turnId' = 0 /\ turnRow' = 0
  /\ turnPhase' = "none" /\ envelopes' = {}
  /\ reply' = "none" /\ replyRow' = 0 /\ replyWake' = 0
  /\ ownerQueued' = FALSE
  /\ UNCHANGED <<rowV, wakeV, policy, nextTurn,
                  ownerMessages, bridgeRestarts, serverRestarts,
                  shownByTurn, deliveredByTurn, outboxByTurn, outboxParts, markedParts, toldCount, secondTried, ghostV>>

\* Явный Close разрешает убрать недоставленный Outcome. Автоматический T12 ниже — только
\* после delivered; мутант -dropundelivered снимает эту ограду.
Close(r) ==
  /\ rowState[r] = "finished" /\ deliveredTurn[r] = 0
  /\ rowState' = [rowState EXCEPT ![r] = "closed"]
  /\ UNCHANGED <<deliveredTurn, shown, wakeV, turnV, countV, historyV, ghostV, escalated>>

Sweep(r) ==
  /\ rowState[r] \in {"finished", "closed"}
  /\ (rowState[r] = "closed" \/ deliveredTurn[r] # 0 \/ ~KeepUndelivered)
  /\ lostUndelivered' =
       (lostUndelivered \/ (rowState[r] = "finished" /\ deliveredTurn[r] = 0))
  /\ rowState' = [rowState EXCEPT ![r] = "deleted"]
  /\ shown' = [shown EXCEPT ![r] = 0]
  /\ UNCHANGED <<deliveredTurn, wakeV, turnV, countV, historyV,
                  wakeWhileBusy, wakeCollision, doubleStamp, escalated>>

\* Нормальный справедливый путь Bridge. В каждом состоянии ровно одна ветка продвигает
\* старейший Outcome или завершает сообщение владельца.
BridgeStep ==
  \/ StampWake
  \/ /\ reply = "none" /\ turnPhase = "active" /\ envelopes = {}
     /\ (chat = "owner" \/ (chat = "wake" /\ turnRow \notin ReadyRows))
     /\ chat' = "free" /\ turnId' = 0 /\ turnRow' = 0
     /\ turnPhase' = "none" /\ envelopes' = {}
     /\ UNCHANGED <<rowV, wakeV, reply, replyRow, replyWake,
                     ownerQueued, policy, conversation, nextTurn, countV, historyV, ghostV>>
  \/ /\ reply = "none" /\ chat = "free" /\ ownerQueued /\ nextTurn <= MaxTurns
     /\ chat' = "owner" /\ turnId' = nextTurn /\ turnRow' = 0
     /\ turnPhase' = "active" /\ envelopes' = {}
     /\ ownerQueued' = FALSE /\ nextTurn' = nextTurn + 1
     /\ UNCHANGED <<rowV, wakeV, reply, replyRow, replyWake,
                     policy, conversation, countV, historyV, ghostV>>
  \/ /\ reply = "none" /\ chat = "wake" /\ turnPhase = "active" /\ shownByTurn[turnId] = {}
     /\ turnRow \in ReadyRows /\ ReadOutcome(turnRow)
  \/ /\ reply = "none" /\ chat \in {"wake", "owner"}
     /\ turnPhase = "active" /\ envelopes # {}
     /\ OutboxFull
  \/ /\ reply = "none" /\ chat \in {"wake", "owner"}
     /\ turnPhase = "outbox" /\ MarkDelivered
  \/ /\ reply = "none" /\ turnPhase = "between" /\ EndTurn
  \/ /\ reply = "none" /\ chat = "free" /\ ~ownerQueued /\ ReadyRows # {}
     /\ LET r == OldestReady IN
          IF wakeId[r] = 0 \/ wakeSent[r] THEN AllocWake(r) ELSE SendWake(r)

Next ==
  \/ BridgeStep \/ LoseBridgeReply \/ BridgeCrash \/ ResponseWithoutRead
  \/ OutboxFailure \/ PartialSend \/ T15WriteFailure \/ SecondOutbox
  \/ OwnerMessage \/ CancelTurn \/ FailTurn \/ ServerCrash \/ NewConversation
  \/ \E r \in Rows :
       HelperFinished(r) \/ ReadOutcome(r) \/ ReadSecondOutcome(r)
       \/ Close(r) \/ Sweep(r) \/ SendWake(r) \/ Escalate(r) \/ ReplayReceipt(r)

Spec == Init /\ [][Next]_vars /\ WF_vars(BridgeStep)

TypeOK ==
  /\ rowState \in [Rows -> RowStates]
  /\ deliveredTurn \in [Rows -> 0..MaxTurns]
  /\ shown \in [Rows -> 0..MaxTurns]
  /\ escalated \in [Rows -> BOOLEAN]
  /\ wakeId \in [Rows -> 0..MaxWake]
  /\ wakeSent \in [Rows -> BOOLEAN]
  /\ wakes \in [Rows -> Nat]
  /\ stamped \in [Rows -> SUBSET WakeIds]
  /\ wakeSeq \in 0..MaxWake
  /\ allocCount \in [WakeIds -> Nat]
  /\ acceptedIds \subseteq WakeIds
  /\ chat \in Chats /\ turnId \in 0..MaxTurns /\ turnRow \in 0..N
  /\ turnPhase \in TurnPhases /\ envelopes \subseteq Rows
  /\ reply \in Replies /\ replyRow \in 0..N /\ replyWake \in 0..MaxWake
  /\ ownerQueued \in BOOLEAN /\ policy \in Policies
  /\ conversation \in 0..MaxNews /\ nextTurn \in 1..(MaxTurns + 1)
  /\ failures \in 0..MaxFailures /\ ownerMessages \in 0..MaxOwnerMessages
  /\ news \in 0..MaxNews /\ bridgeRestarts \in Nat /\ serverRestarts \in Nat
  /\ shownByTurn \in [Turns -> SUBSET Rows]
  /\ deliveredByTurn \in [Turns -> SUBSET Rows]
  /\ outboxByTurn \in [Turns -> BOOLEAN]
  /\ outboxParts \in [Turns -> 0..2]
  /\ markedParts \in [Turns -> 0..2]
  /\ toldCount \in [Rows -> Nat] /\ lostMarkEver \in [Rows -> BOOLEAN]
  /\ secondTried \in [Turns -> BOOLEAN]
  /\ {wakeWhileBusy, wakeCollision, doubleStamp, lostUndelivered} \subseteq BOOLEAN

DeliveredOnlyAfterShownAndOutbox ==
  \A r \in Rows : deliveredTurn[r] # 0 =>
    (r \in shownByTurn[deliveredTurn[r]] /\ outboxByTurn[deliveredTurn[r]])

\* Исторический критерий чтений, отклонён приёмкой: контракт — OneDeliveredPerTurn.
OneOutcomePerTurn ==
  \A t \in Turns : Cardinality(shownByTurn[t]) <= 1

ClosedHasNoDelivery ==
  \A r \in Rows : rowState[r] = "closed" => deliveredTurn[r] = 0

OneDeliveredPerTurn ==
  \A t \in Turns : Cardinality(deliveredByTurn[t]) <= 1

NoMultipartCompletion ==
  \A t \in Turns : ~(outboxParts[t] = 2 /\ markedParts[t] = 2)

NoWakeWhileBusy == ~wakeWhileBusy

WakeIdUnique ==
  /\ ~wakeCollision
  /\ \A w \in WakeIds : allocCount[w] <= 1

WakesCountedOnce ==
  /\ ~doubleStamp
  /\ \A r \in Rows : wakes[r] = Cardinality(stamped[r])

\* Второй пересказ допустим только если прошлый Telegram side effect остался без durable T15.
DupOnlyWithoutDurableMark ==
  \A r \in Rows : toldCount[r] <= 1 \/ lostMarkEver[r]

UndeliveredKept == ~lostUndelivered

\* При справедливом Bridge и конечном failures каждый готовый Outcome доставляется либо
\* закрывается владельцем. /new, обе политики, падения и отказы не меняют обещание.
EventuallyDelivered ==
  \A r \in Rows :
    (rowState[r] = "finished" /\ deliveredTurn[r] = 0)
      ~> (deliveredTurn[r] # 0 \/ rowState[r] \in {"closed", "deleted"})

\* Точные replay: ровно шесть состояний; в конце stutter разрешён TLC -deadlock.
ReplayInit == Init /\ rowState = [r \in Rows |-> "finished"] /\ policy = "queue"
OldCounterNext ==
  \/ /\ chat = "free" /\ nextTurn = 1 /\ OwnerMessage
  \/ /\ chat = "owner" /\ envelopes = {} /\ rowState[2] = "finished" /\ Close(2)
  \/ /\ chat = "owner" /\ envelopes = {} /\ rowState[2] = "closed" /\ ReadOutcome(2)
  \/ /\ envelopes = {2} /\ rowState[2] = "closed" /\ Sweep(2)
  \/ /\ envelopes = {2} /\ rowState[2] = "deleted" /\ shown[1] = 0 /\ ReadOutcome(1)
Fix3Next ==
  \/ /\ chat = "free" /\ nextTurn = 1 /\ OwnerMessage
  \/ /\ chat = "owner" /\ envelopes = {} /\ rowState[2] = "finished" /\ ReadOutcome(2)
  \/ /\ envelopes = {2} /\ rowState[2] = "finished" /\ Close(2)
  \/ /\ envelopes = {2} /\ rowState[2] = "closed" /\ Sweep(2)
  \/ /\ envelopes = {2} /\ rowState[2] = "deleted" /\ shown[1] = 0 /\ ReadOutcome(1)


\* Достижимый multipart replay: два Outbox и два T15, T12 между ними.
MultipartNext ==
  \/ /\ chat = "free" /\ nextTurn = 1 /\ OwnerMessage
  \/ /\ chat = "owner" /\ turnPhase = "active" /\ envelopes = {} /\ ReadOutcome(1)
  \/ /\ turnPhase = "active" /\ envelopes = {1} /\ OutboxFull
  \/ /\ turnPhase = "outbox" /\ MarkDelivered
  \/ /\ turnPhase = "between" /\ rowState[1] = "finished" /\ Sweep(1)
  \/ /\ turnPhase = "between" /\ rowState[1] = "deleted" /\ SecondOutbox
  \/ /\ turnPhase = "between" /\ outboxParts[turnId] = 2 /\ EndTurn

\* VIEW убирает только независимые диагностические измерения. Их значения не
\* влияют на BridgeStep, ReadyRows, safety и обещание доставки; Escalate и отказ
\* второго чтения становятся self-loop. envelopes влияет лишь через непустоту.
\* Multipart counters are read only for the active turn; nextTurn never reuses
\* an old id. Keep its two counters and all historical shown/delivery/outbox
\* evidence. Replay/reachability configs have no VIEW and retain full counters.
View == <<rowState, deliveredTurn, shown, wakeId, wakeSent, wakes, stamped, wakeSeq,
          allocCount, acceptedIds, chat, turnId, turnRow, turnPhase, envelopes # {},
          reply, replyRow, replyWake, ownerQueued, policy, nextTurn,
          failures, ownerMessages, news,
          shownByTurn, deliveredByTurn, outboxByTurn,
          IF turnId = 0 THEN <<>> ELSE <<outboxParts[turnId], markedParts[turnId]>>,
          toldCount, lostMarkEver,
          wakeWhileBusy, wakeCollision, doubleStamp, lostUndelivered>>

\* Temporal-only view: older safety observers never guard operational actions.
\* Keep every durable wake/row fact, all finite interference counts and the
\* active turn's shown/parts markers. BridgeStep always changes retained state;
\* its weak fairness and EventuallyDelivered are preserved. Safety uses View
\* with full historical shown/delivered/outbox evidence; replays use full vars.
LiveView == <<rowState, deliveredTurn, shown, wakeId, wakeSent, wakes, stamped, wakeSeq,
              acceptedIds, chat, turnId, turnRow, turnPhase, envelopes # {},
              reply, replyRow, replyWake, ownerQueued, policy, nextTurn,
              failures, ownerMessages, news,
              IF turnId = 0 THEN <<>>
              ELSE <<shownByTurn[turnId], outboxParts[turnId], markedParts[turnId]>>>>

====
