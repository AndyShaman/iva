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

EXTENDS Integers, FiniteSets, Sequences

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

BaseInit ==
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

BaseNext ==
  \/ BridgeStep \/ LoseBridgeReply \/ BridgeCrash \/ ResponseWithoutRead
  \/ OutboxFailure \/ PartialSend \/ T15WriteFailure \/ SecondOutbox
  \/ OwnerMessage \/ CancelTurn \/ FailTurn \/ ServerCrash \/ NewConversation
  \/ \E r \in Rows :
       HelperFinished(r) \/ ReadOutcome(r) \/ ReadSecondOutcome(r)
       \/ Close(r) \/ Sweep(r) \/ SendWake(r) \/ Escalate(r) \/ ReplayReceipt(r)

VARIABLE v6
CONSTANTS V6Case, V6Mutant
Init == BaseInit /\ v6 = "legacy"
Next == BaseNext /\ UNCHANGED v6

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
BaseOldCounterNext ==
  \/ /\ chat = "free" /\ nextTurn = 1 /\ OwnerMessage
  \/ /\ chat = "owner" /\ envelopes = {} /\ rowState[2] = "finished" /\ Close(2)
  \/ /\ chat = "owner" /\ envelopes = {} /\ rowState[2] = "closed" /\ ReadOutcome(2)
  \/ /\ envelopes = {2} /\ rowState[2] = "closed" /\ Sweep(2)
  \/ /\ envelopes = {2} /\ rowState[2] = "deleted" /\ shown[1] = 0 /\ ReadOutcome(1)
BaseFix3Next ==
  \/ /\ chat = "free" /\ nextTurn = 1 /\ OwnerMessage
  \/ /\ chat = "owner" /\ envelopes = {} /\ rowState[2] = "finished" /\ ReadOutcome(2)
  \/ /\ envelopes = {2} /\ rowState[2] = "finished" /\ Close(2)
  \/ /\ envelopes = {2} /\ rowState[2] = "closed" /\ Sweep(2)
  \/ /\ envelopes = {2} /\ rowState[2] = "deleted" /\ shown[1] = 0 /\ ReadOutcome(1)


\* Достижимый multipart replay: два Outbox и два T15, T12 между ними.
BaseMultipartNext ==
  \/ /\ chat = "free" /\ nextTurn = 1 /\ OwnerMessage
  \/ /\ chat = "owner" /\ turnPhase = "active" /\ envelopes = {} /\ ReadOutcome(1)
  \/ /\ turnPhase = "active" /\ envelopes = {1} /\ OutboxFull
  \/ /\ turnPhase = "outbox" /\ MarkDelivered
  \/ /\ turnPhase = "between" /\ rowState[1] = "finished" /\ Sweep(1)
  \/ /\ turnPhase = "between" /\ rowState[1] = "deleted" /\ SecondOutbox
  \/ /\ turnPhase = "between" /\ outboxParts[turnId] = 2 /\ EndTurn

OldCounterNext == BaseOldCounterNext /\ UNCHANGED v6

Fix3Next == BaseFix3Next /\ UNCHANGED v6

MultipartNext == BaseMultipartNext /\ UNCHANGED v6

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

\* v6.0 delivery/source extension. The old Spec is retained only as a
\* regression graph. V6Spec preserves complete evidence and uses no VIEW.
\* Clock ticks are abstract KEEP units; finish and delivery clocks are separate.
\* Sources are trusted metadata, not words in a message. "legacy" is absence.
V6OVars == <<vars, v6>>
\* First component is the chat partition; session identity includes that
\* partition. The persisted turn mark itself remains (sessionId, turnId, at).
V6Keys == (1..2) \X (0..1) \X (0..2)
V6Inputs == {"owner", "tap", "wake", "legacy"}
V6SameKey(a, b) ==
  IF a = <<>> \/ b = <<>> THEN FALSE
  ELSE IF V6Mutant = "session" THEN a[3] = b[3]
  ELSE IF V6Mutant = "chat" THEN a[2] = b[2] /\ a[3] = b[3]
  ELSE a = b
V6Homogeneous(xs) == Cardinality({xs[i] : i \in 1..Len(xs)}) <= 1
V6Compatible(a, b) == a = b \/ a = "legacy" \/ b = "legacy"
V6LegacyMix == \E i \in 1..Len(v6.current) : v6.current[i] = "legacy"
V6OInit ==
  /\ BaseInit
  /\ rowState = [r \in Rows |-> "running"] /\ policy = "queue"
  /\ \E chats \in {[r \in 1..2 |-> 1], [r \in 1..2 |-> r]} :
     /\ V6Case # "delivery-live" \/ chats = [r \in 1..2 |-> 1]
     /\ v6 = [state |-> [r \in 1..2 |-> "finished"], rowChat |-> chats,
       shown |-> [r \in 1..2 |-> [key |-> <<>>, at |-> 0]],
       delivered |-> [r \in 1..2 |-> [key |-> <<>>, at |-> 0]],
       finishAt |-> [r \in 1..2 |-> 0], partial |-> [r \in 1..2 |-> TRUE],
       key |-> <<1, 0, 0>>, newCount |-> 0, envelopes |-> {},
       shownHistory |-> {}, outboxHistory |-> {}, deliveryHistory |-> {},
       now |-> 0, sweptEarly |-> FALSE, manualRead |-> {},
       alert |-> "idle", escalated |-> FALSE, confirms |-> 0,
       alertCrashes |-> 0, alertFailures |-> 0, wakeCount |-> 1,
       wakeId |-> 1, stamped |-> {}, wakeAttempts |-> 0,
       pendingBridge |-> FALSE, pendingKernel |-> FALSE,
       busy |-> FALSE, reset |-> FALSE, compacting |-> FALSE,
       busyWake |-> FALSE, forbidden |-> FALSE, effects |-> 0,
       queue |-> <<>>, bridge |-> <<>>, kernel |-> <<>>, current |-> <<>>,
       admitted |-> <<>>, completed |-> <<>>, source |-> "none",
       policy |-> "queue", race |-> "none", restarts |-> 0,
       sourceLost |-> FALSE, legacyChanged |-> FALSE, lostMark |-> FALSE,
       manualWrote |-> FALSE, deliveredReadWrote |-> FALSE,
       lastAt |-> [r \in 1..2 |-> 0], rowWakes |-> [r \in 1..2 |-> 0],
       rowAttempts |-> [r \in 1..2 |-> 0], rowSent |-> [r \in 1..2 |-> FALSE],
       attemptTimeline |-> {}, wakeRow |-> 0, wrongOrder |-> FALSE,
       ownerLeak |-> FALSE, pass |-> 0, allocatedPass |-> -1,
       failures |-> 0, failedKeys |-> {}]

V6Read(r) ==
  /\ v6.state[r] \in {"finished", "closed"}
  /\ v6.rowChat[r] = v6.key[1]
  /\ v6.key \notin v6.outboxHistory
  /\ v6.state[r] = "closed"
      \/ v6.delivered[r].key # <<>>
      \/ V6Mutant = "second-finished"
      \/ ~\E q \in (1..2) \ {r} : v6.state[q] = "finished"
            /\ v6.rowChat[q] = v6.key[1] /\ v6.delivered[q].key = <<>>
            /\ V6SameKey(v6.shown[q].key, v6.key)
  /\ v6' = [v6 EXCEPT
       !.shown[r] = IF (v6.state[r] = "finished" /\ v6.delivered[r].key = <<>>)
                      \/ V6Mutant \in {"closed-mark", "delivered-mark"}
                   THEN [key |-> v6.key, at |-> v6.now] ELSE @,
       !.manualWrote = @ \/ (v6.state[r] = "closed" /\ V6Mutant = "closed-mark"),
       !.deliveredReadWrote = @ \/ (v6.delivered[r].key # <<>> /\ V6Mutant = "delivered-mark"),
       !.envelopes = @ \cup {r},
       !.manualRead = IF v6.state[r] = "closed" THEN @ \cup {r} ELSE @,
       !.shownHistory = IF v6.state[r] = "finished" /\ v6.delivered[r].key = <<>>
                        THEN @ \cup {<<v6.key, r>>} ELSE @]
V6Outbox ==
  /\ v6.envelopes # {}
  /\ v6' = [v6 EXCEPT !.outboxHistory = @ \cup {v6.key}]
V6Mark ==
  /\ v6.key \in v6.outboxHistory
  /\ v6.key \notin v6.failedKeys
  /\ LET rs == {r \in 1..2 : v6.state[r] = "finished" /\ v6.delivered[r].key = <<>>
                              /\ (v6.rowChat[r] = v6.key[1] \/ V6Mutant = "chat")
                              /\ V6SameKey(v6.shown[r].key, v6.key)} IN
       /\ rs # {}
       /\ v6' = [v6 EXCEPT
            !.delivered = [r \in 1..2 |-> IF r \in rs THEN [key |-> v6.key, at |-> v6.now] ELSE v6.delivered[r]],
            !.deliveryHistory = @ \cup {<<v6.key, r>> : r \in rs}]
V6New ==
  /\ v6.newCount = 0
  /\ \E k \in {<<1, 1, 0>>, <<2, 0, 0>>} :
       /\ V6Case # "delivery-live" \/ k[1] = 1
       /\ v6' = [v6 EXCEPT !.key = k, !.newCount = 1, !.envelopes = {}]
\* /new reuses local turn_0; different chats also reuse the same local id.
V6CloseRow(r) ==
  /\ v6.state[r] = "finished" /\ v6.delivered[r].key = <<>>
  /\ v6.rowChat[r] = v6.key[1]
  /\ v6' = [v6 EXCEPT !.state[r] = "closed"]
V6Time ==
  /\ v6.now < (IF V6Case = "wakes" THEN 4 ELSE 2)
  /\ v6' = [v6 EXCEPT !.now = @ + 1]
V6OSweep(r) ==
  /\ v6.state[r] # "deleted"
  /\ v6.state[r] = "closed" \/ v6.delivered[r].key # <<>>
  /\ LET at == IF v6.state[r] = "closed" THEN v6.finishAt[r] ELSE v6.delivered[r].at
         checkedAt == IF V6Mutant = "delivered-clock" THEN v6.finishAt[r] ELSE at IN
       /\ v6.now >= checkedAt + 1 \/ V6Mutant = "sweep"
       /\ v6' = [v6 EXCEPT !.state[r] = "deleted", !.sweptEarly = v6.now < at + 1]

\* T17 has no separate queue. Attempt/confirmation are observations of the
\* existing Alert seam. A crash loses only volatile phase, not an accepted Alert.
V6AlertAttempt ==
  /\ ~v6.escalated /\ v6.alert = "idle" /\ v6.wakeCount >= 1
  /\ v6' = [v6 EXCEPT !.alert = "attempt",
       !.escalated = IF V6Mutant = "alert-order" THEN TRUE ELSE @]
V6AlertConfirm ==
  /\ v6.alert = "attempt" /\ v6.confirms < 2
  /\ v6' = [v6 EXCEPT !.alert = "confirmed", !.confirms = @ + 1]
V6AlertMark ==
  /\ v6.alert = "confirmed" /\ ~v6.escalated
  /\ v6' = [v6 EXCEPT !.escalated = TRUE]
V6AlertFailure ==
  /\ v6.alert = "attempt" /\ v6.alertFailures < 1
  /\ v6' = [v6 EXCEPT !.alert = "idle", !.alertFailures = @ + 1]
V6AlertCrash ==
  /\ v6.alert = "confirmed" /\ ~v6.escalated /\ v6.alertCrashes < 1
  /\ v6' = [v6 EXCEPT !.alert = "idle", !.alertCrashes = @ + 1]
V6WakeAgain ==
  /\ v6.wakeId < 2
  /\ v6' = [v6 EXCEPT !.wakeId = @ + 1]
V6Stamp ==
  /\ (v6.wakeId \notin v6.stamped \/ V6Mutant = "stamp")
  /\ v6.wakeAttempts < 2
  /\ v6' = [v6 EXCEPT !.stamped = @ \cup {v6.wakeId},
       !.wakeCount = @ + 1, !.wakeAttempts = @ + 1]

\* Busy/reset/compaction and both owner input accumulators precede admission.
V6PrepareWake ==
  /\ v6.race = "none"
  /\ \E b, k, active, resetting, compact \in BOOLEAN :
       v6' = [v6 EXCEPT !.pendingBridge = b, !.pendingKernel = k,
         !.busy = active, !.reset = resetting, !.compacting = compact,
         !.race = "checked"]
V6WakeAllowed == ~(v6.pendingBridge \/ v6.pendingKernel \/ v6.busy \/ v6.reset \/ v6.compacting)
V6WakeStart ==
  /\ v6.race = "checked" /\ (V6WakeAllowed \/ V6Mutant = "wake-guard")
  /\ v6' = [v6 EXCEPT !.race = "started", !.source = "wake",
       !.busyWake = ~V6WakeAllowed]
V6WakeOperation(op) ==
  /\ v6.source = "wake"
  /\ op \in {"read", "outbox"} \/ (V6Mutant = "wake-action" /\ op \in {"start", "close", "effect"})
  /\ v6' = [v6 EXCEPT !.forbidden = op \in {"start", "close", "effect"},
       !.effects = IF op = "effect" THEN @ + 1 ELSE @]

\* Full two-delivery pipeline; next different input remains queued. Both
\* arrival orders, queue/steer, active step and idle-check race are explored.
V6Admission ==
  /\ v6.admitted = <<>> /\ v6.race = "none"
  /\ \E xs \in {<<"wake", "owner">>, <<"owner", "wake">>,
                 <<"owner", "owner">>, <<"tap", "wake">>, <<"legacy", "legacy">>,
                 <<"legacy", "wake">>, <<"wake", "legacy">>},
          p \in {"queue", "steer"}, timing \in {"idle", "active", "idle-race"} :
       v6' = [v6 EXCEPT !.queue = xs, !.admitted = xs, !.policy = p,
         !.busy = timing = "active", !.race = timing,
         !.pendingBridge = timing = "idle-race"]
V6BridgeCollect ==
  /\ v6.bridge = <<>> /\ v6.queue # <<>>
  /\ LET count == IF Len(v6.queue) = 2 /\
           (v6.queue[1] = v6.queue[2] \/ V6Mutant = "bridge-mixed") THEN 2 ELSE 1 IN
       v6' = [v6 EXCEPT !.bridge = SubSeq(v6.queue, 1, count),
         !.queue = SubSeq(v6.queue, count + 1, Len(v6.queue))]
V6KernelAccept ==
  /\ v6.bridge # <<>>
  /\ v6' = [v6 EXCEPT !.kernel = v6.kernel \o v6.bridge, !.bridge = <<>>]
V6KernelStart ==
  /\ v6.kernel # <<>> /\ v6.current = <<>>
  /\ ~v6.busy \/ v6.policy = "steer"
  /\ LET count == IF Len(v6.kernel) = 2 /\ V6Mutant = "legacy"
                        /\ (v6.kernel[1] = "legacy" \/ v6.kernel[2] = "legacy") THEN 1
           ELSE IF Len(v6.kernel) = 2 /\
           (V6Compatible(v6.kernel[1], v6.kernel[2]) \/ V6Mutant = "kernel-mixed") THEN 2 ELSE 1 IN
       v6' = [v6 EXCEPT !.current = SubSeq(v6.kernel, 1, count),
         !.source = v6.kernel[count], !.kernel = SubSeq(v6.kernel, count + 1, Len(v6.kernel)),
         !.legacyChanged = V6Mutant = "legacy" /\ Len(v6.kernel) = 2
                                 /\ (v6.kernel[1] = "legacy" \/ v6.kernel[2] = "legacy"),
         !.busy = FALSE, !.pendingBridge = FALSE]
V6ActiveEnd ==
  /\ v6.busy
  /\ v6' = [v6 EXCEPT !.busy = FALSE]
V6Execute ==
  /\ v6.current # <<>>
  /\ v6' = [v6 EXCEPT !.completed = @ \o v6.current, !.current = <<>>, !.source = "none"]
V6QueueRestart ==
  /\ v6.restarts = 0 /\ v6.admitted # <<>>
  /\ v6' = [v6 EXCEPT !.restarts = 1,
       !.sourceLost = V6Mutant = "source-loss",
       !.queue = IF V6Mutant = "source-loss" THEN <<>> ELSE @]

\* An actual ordering witness: Bridge observes idle; owner arrives; the
\* already prepared wake reaches admission. The two requests stay distinct.
V6IdleCheck ==
  /\ v6.race = "none" /\ v6.admitted = <<>>
  /\ v6' = [v6 EXCEPT !.race = "checked"]
V6OwnerBetween ==
  /\ v6.race = "checked"
  /\ v6' = [v6 EXCEPT !.queue = <<"owner">>, !.admitted = <<"owner">>,
       !.pendingBridge = TRUE, !.race = "owner-arrived"]
V6StaleWakeAdmission ==
  /\ v6.race = "owner-arrived"
  /\ \E p \in {"queue", "steer"} :
       v6' = [v6 EXCEPT !.queue = @ \o <<"wake">>, !.admitted = @ \o <<"wake">>,
         !.policy = p, !.race = "admitted-after-owner"]

\* V1/C3: every attempt (including terminal-drop) stamps lastWakeAt at T13.
\* The nonzero minimum applies even when wakes is still zero. Accepted count
\* controls the growing pause; each row has its own due time.
V6Pause(r) == 2 ^ v6.rowWakes[r]
V6Due(r) == IF v6.rowAttempts[r] = 0 THEN 0 ELSE v6.lastAt[r] + V6Pause(r)
V6DueRows == {r \in 1..2 : v6.rowAttempts[r] < 2 /\ v6.now >= V6Due(r)}
V6WakeAllocate ==
  /\ v6.wakeRow = 0 /\ v6.pass < 3 /\ v6.allocatedPass # v6.pass
  /\ \E r \in 1..2 :
       /\ v6.rowAttempts[r] < 2
       /\ (r \in V6DueRows) \/ V6Mutant = "wake-pause"
       /\ (\A q \in V6DueRows : V6Due(r) <= V6Due(q)) \/ V6Mutant = "wake-order"
       /\ v6' = [v6 EXCEPT !.wakeRow = r, !.allocatedPass = v6.pass,
            !.attemptTimeline = @ \cup {<<r, v6.now, V6Due(r)>>},
            !.lastAt[r] = v6.now, !.rowAttempts[r] = @ + 1, !.rowSent[r] = FALSE,
            !.wrongOrder = ~ (\A q \in V6DueRows : V6Due(r) <= V6Due(q))]
V6WakeResult ==
  /\ v6.wakeRow # 0
  /\ \E result \in {"accepted", "busy", "reject", "terminal-drop"} :
       v6' = [v6 EXCEPT !.rowSent[v6.wakeRow] = result = "accepted",
         !.rowWakes[v6.wakeRow] = IF result = "accepted" THEN @ + 1 ELSE @,
         !.ownerLeak = @ \/ (result = "terminal-drop" /\ V6Mutant = "terminal-message"),
         !.wakeRow = 0]
V6Pass ==
  /\ v6.wakeRow = 0 /\ v6.pass < 3
  /\ v6' = [v6 EXCEPT !.pass = @ + 1]

V6DeliveryNext ==
  \/ \E r \in 1..2 : V6Read(r) \/ V6CloseRow(r) \/ V6OSweep(r)
  \/ V6Outbox \/ V6Mark \/ V6New \/ V6Time
V6Ready == {r \in 1..2 : v6.state[r] = "finished" /\ v6.delivered[r].key = <<>>
                          /\ v6.rowChat[r] = v6.key[1]}
V6NextTurn ==
  /\ v6.key \in v6.outboxHistory /\ v6.key[3] < 2
  /\ v6.key \in v6.failedKeys \/ ~ENABLED V6Mark
  /\ v6' = [v6 EXCEPT !.key = <<v6.key[1], v6.key[2], v6.key[3] + 1>>, !.envelopes = {}]
V6DeliveryFailure ==
  /\ v6.key \in v6.outboxHistory /\ v6.failures < 1
  /\ ENABLED V6Mark
  /\ v6' = [v6 EXCEPT !.failedKeys = @ \cup {v6.key}, !.failures = @ + 1,
       !.lostMark = TRUE, !.envelopes = {}]
V6DeliveryProgress ==
  \/ /\ v6.envelopes = {} /\ v6.key \notin v6.outboxHistory /\ V6Ready # {}
     /\ V6Read(CHOOSE r \in V6Ready : \A q \in V6Ready : r <= q)
  \/ /\ v6.envelopes # {} /\ v6.key \notin v6.outboxHistory /\ V6Outbox
  \/ V6Mark
  \/ /\ V6Ready # {} /\ V6NextTurn
V6AlertNext ==
  \/ V6AlertAttempt \/ V6AlertConfirm \/ V6AlertMark
  \/ V6AlertFailure \/ V6AlertCrash \/ V6WakeAgain \/ V6Stamp
V6PipelineNext ==
  \/ /\ V6Case = "pipeline" /\ V6Admission
  \/ /\ V6Case = "pipeline-race" /\ (V6IdleCheck \/ V6OwnerBetween \/ V6StaleWakeAdmission)
  \/ V6BridgeCollect \/ V6KernelAccept \/ V6KernelStart
  \/ V6ActiveEnd \/ V6Execute \/ V6QueueRestart
V6ONext ==
  /\ CASE V6Case = "delivery" -> V6DeliveryNext
       [] V6Case = "delivery-live" -> V6DeliveryProgress \/ V6New
          \/ V6DeliveryFailure \/ (\E r \in 1..2 : V6CloseRow(r))
       [] V6Case = "alert" -> V6AlertNext
       [] V6Case \in {"pipeline", "pipeline-race"} -> V6PipelineNext
       [] V6Case = "wakes" -> V6WakeAllocate \/ V6WakeResult \/ V6Pass \/ V6Time
       [] V6Case = "wake" -> V6PrepareWake \/ V6WakeStart
            \/ (\E op \in {"read", "outbox", "start", "close", "effect"} : V6WakeOperation(op))
       [] OTHER -> FALSE
  /\ UNCHANGED vars
V6OSpec == V6OInit /\ [][V6ONext]_V6OVars
V6DeliverySpec == V6OSpec /\ WF_V6OVars(V6DeliveryProgress /\ UNCHANGED vars)
V6EventuallyDelivered == \A r \in 1..2 :
  v6.state[r] = "finished" ~> (v6.delivered[r].key # <<>> \/ v6.state[r] \in {"closed", "deleted"})
V6AlertSpec == V6OSpec
  /\ WF_V6OVars(V6AlertAttempt /\ UNCHANGED vars)
  /\ WF_V6OVars(V6AlertConfirm /\ UNCHANGED vars)
  /\ WF_V6OVars(V6AlertMark /\ UNCHANGED vars)
V6PipelineSpec == V6OSpec
  /\ WF_V6OVars(V6BridgeCollect /\ UNCHANGED vars)
  /\ WF_V6OVars(V6KernelAccept /\ UNCHANGED vars)
  /\ WF_V6OVars(V6KernelStart /\ UNCHANGED vars)
  /\ WF_V6OVars(V6ActiveEnd /\ UNCHANGED vars)
  /\ WF_V6OVars(V6Execute /\ UNCHANGED vars)

V6OTypeOK ==
  /\ v6.key \in V6Keys /\ v6.now \in 0..4
  /\ v6.state \in [1..2 -> {"finished", "closed", "deleted"}]
  /\ \A r \in 1..2 : v6.shown[r].key \in V6Keys \cup {<<>>}
                       /\ v6.delivered[r].key \in V6Keys \cup {<<>>}
  /\ v6.source \in V6Inputs \cup {"none"}
V6DeliveryProven == \A item \in v6.deliveryHistory :
  item \in v6.shownHistory /\ item[1] \in v6.outboxHistory
V6OneDeliveredPerTurn == \A k \in V6Keys :
  Cardinality({r \in 1..2 : <<k, r>> \in v6.deliveryHistory}) <= 1
V6ClosedHasNoDelivery == \A r \in 1..2 :
  v6.state[r] = "closed" => v6.delivered[r].key = <<>>
V6ManualNoShown == ~v6.manualWrote
V6DeliveredReadNoWrite == ~v6.deliveredReadWrote
V6WakePause == \A t \in v6.attemptTimeline : t[2] >= t[3]
V6WakeEarliest == ~v6.wrongOrder
V6WakeNoOwnerMessage == ~v6.ownerLeak
V6Retention == ~v6.sweptEarly
V6AlertConfirmed == v6.escalated => v6.confirms > 0
V6AlertEventually == <>v6.escalated
V6WakeCounting == v6.wakeCount = 1 + Cardinality(v6.stamped)
V6NoWakeWhileBusy == ~v6.busyWake
V6WakeReadOnly == ~v6.forbidden /\ v6.effects = 0
V6BridgeHomogeneous == (\E i \in 1..Len(v6.bridge) : v6.bridge[i] = "legacy") \/ V6Homogeneous(v6.bridge)
V6KernelHomogeneous == V6LegacyMix \/ V6Homogeneous(v6.current)
V6CurrentSource == V6LegacyMix \/ v6.current = <<>> \/ (\A i \in 1..Len(v6.current) : v6.current[i] = v6.source)
V6SourceKept == v6.completed \o v6.current \o v6.kernel \o v6.bridge \o v6.queue = v6.admitted
V6LegacySame == ~v6.legacyChanged
V6NoDeliveryLost == Len(v6.queue) + Len(v6.bridge) + Len(v6.kernel)
                          + Len(v6.current) + Len(v6.completed) = Len(v6.admitted)
V6PipelineEventually == v6.admitted # <<>> ~> v6.completed = v6.admitted
\* Must fail: confirmation/crash before mark permits a duplicate Alert.
V6NoDuplicateAlert == v6.confirms <= 1
\* Historical read-count guarantee is intentionally absent. Close then read
\* another outcome is allowed; only finished deliveries are restricted.
V6NoTwoReads == Cardinality(v6.envelopes) <= 1
====
