---- MODULE QueueDrain ----
\* Слив очереди Bridge пачкой (спека .scratch/work/wave-1010/l5/spec-v1.md, раздел 7). Модель
\* написана ДО кода: она проверяет замысел, не код.
\*
\* Что описывает. Один чат; два автора; сообщения 1..N, у каждого автор и вид: plain —
\* склеивается, alone — идёт отдельной доставкой (команда, подпись-команда, ответ, тап по кнопке
\* модели, сообщение без from). Inbox каждого автора — свой FIFO; маршрут головы inbox (в очередь
\* или прямой доставкой в eve) и снятие её с inbox — разные шаги. Очередь Bridge этого чата. Слив:
\* выбор пачки (закреп или queueBatchLength), доставка, снятие набора одной записью. Ledger eve —
\* id доставок, на которые она начала ход: доставка с id из ledger получает handled. Занятость
\* чата ходом или свёрткой (запись running). queueInFlight чата. Перезапуск Bridge: память
\* (фаза слива, закреп, inFlight) пуста, inbox, очередь и ledger на диске. Потеря id ledger
\* (ошибка записи, вытеснение из последних 200) — переключатель окружения.
\*
\* Чего не описывает: склейку входа коллектором (элемент inbox — одно сообщение); границы в
\* частях и знаках (вместо них MaxItems элементов); ответ на сообщение бота мимо очереди; /new,
\* ограду сброса и clearChatQueue; closed-session; отрицательные id без ledger (синтетика меню и
\* старый формат: их повтор и сегодня даёт второй ход); время (срок доставки 5 с, settleUntil,
\* ожидание running после принятия — недетерминизм порядка шагов); несколько чатов; содержимое
\* частей и как Inbound pipeline их читает; то, что Ива отвечает по смыслу на все части.
\*
\* id сравниваются только на равенство (последний элемент пачки, принадлежность ledger и
\* закрепу), поэтому номер id по порядку прихода не теряет общности: случайный скачок update_id
\* у Telegram в модели ничего не меняет.
\*
\* Действие модели -> файл:функция (база ef7966cd; функции слива пачкой — из спеки v1, §3)
\*   Arrive       scripts/poller/inbox.ts:169 admitTelegramUpdate: апдейт в inbox своего автора
\*                (ключ collectorKeyFor = чат + тема + автор, scripts/lib/telegram-collect.ts:75)
\*   Route(a)     inbox.ts:214 promoteReadyInbox -> scripts/poller/routing.ts:212
\*                routeMessageUpdate: mustQueue (:295) = inFlight.has(key) или «Очередь» и
\*                (running или очередь чата не пуста) -> постановка (Enqueue); иначе прямая
\*                доставка routing.ts:97 deliverDirectUpdate: id в ledger -> handled = delivered;
\*                принято; не принято (шага нет: голова ждёт в inbox); принято после срока
\*                Bridge (Late): ход и ledger есть, Bridge видит rejected, голова остаётся в inbox
\*   Enqueue      scripts/lib/telegram-queue.ts:453 enqueueItem: в хвост, дубль id не добавляется
\*   InboxAck(a)  promoteReadyInbox: снятие головы inbox после queued/delivered
\*   StartDrain   routing.ts:335 drainReadyQueueHeads: чат свободен; закреп, если его id стоят с
\*                головы, иначе queueBatchLength; pins.set до доставки; inFlight delivering
\*   Deliver      scripts/poller/deliver.ts:52 deliver -> agent/lib/telegram-acceptance.ts:294:
\*                последний id пачки в ledger -> handled; иначе принято (ход, ledger, чат занят,
\*                inFlight остаётся) / не принято / принято после срока Bridge (Late: ход и ledger
\*                есть, Bridge видит false)
\*   Ack          acknowledgeQueueItems под serializeQueueMutation: очередь, прочитанная заново,
\*                без id пачки; закреп снят. ACK_ROLLED_BACK: очередь прежняя, закреп остаётся.
\*                FATAL_DURABILITY — то же, что Restart
\*   Settle       проход слива видит фазу running и свободный чат: inFlight.delete (routing.ts:416)
\*   Busy / Free  свёртка между ходами занимает свободный чат (agent/lib/idle-compaction.ts) /
\*                ход или свёртка кончились (agent/channels/telegram.ts)
\*   LedgerLoss   recordCompletedUpdate упала после принятия (telegram-acceptance.ts:457) или id
\*                вытеснен из последних 200 (:53)
\*   Switch       владелец переключает «Очередь» / «Перебивать» в /menu (data/settings.json;
\*                telegramTurnPolicy читается на каждом маршруте)
\*   Restart      systemd: память Bridge пуста; .ack-pending восстанавливается до чтения
\*                (telegram-queue.ts:778), поэтому обрыв внутри Ack равен обрыву до него
\*
\* Ack атомарен для других писателей (serializeQueueMutation). Loop = "seq" — главный цикл кода
\* (scripts/poller/main.ts:335-431): продвижение inbox, затем проход слива; маршрут в слив не
\* вклинивается. Loop = "any" — маршрут и постановка между любыми шагами слива: шире кода, так
\* модель покрывает фонового писателя очереди, которого сегодня нет.
\*
\* Переключатели кода (TRUE — спека v1; каждый свидетель снимает один):
\*   Pin         закреп пачки до снятия
\*   SameSender  склеиваются только сообщения автора головы
\*   FreshAck    снятие читает очередь заново и снимает только id пачки
\*   AloneRule   alone идёт отдельной доставкой
\* Предложенная починка (FALSE — спека v1):
\*   QueueFirst  R1: пока очередь чата не пуста, сообщение встаёт за ней и при «Перебивать»
\*               (routeMessageUpdate: mustQueue включает queueCount(queue, key) > 0 при любом
\*               turnPolicy); прямая доставка не обгоняет очередь
\* Окружение: Policy в начале ("queue" — «Очередь», "steer" — «Перебивать»); MaxSwitches —
\* сколько раз владелец переключает режим (при одном «Перебивать» очередь копится только за
\* сливом в полёте, а он бывает только при непустой очереди: без переключения она пуста); Loop;
\* Late — доставка принята после срока Bridge; MaxLedgerLoss; MaxRestarts.
\*
\* Находка F1 (QueueDrain-switch.cfg, Loop = "seq", то есть в порядке кода): спека v1 теряет
\* сообщение. Режим «Очередь», чат занят, у автора a в очереди 1 и 2; владелец включает
\* «Перебивать»; Bridge перезапускается между маршрутом 2 и снятием 2 с inbox; после старта 2
\* уходит прямой доставкой (очередь «Перебивать» не держит) и попадает в ledger; слив берёт
\* пачку 1+2 с id 2 -> handled -> снятие убирает и 1, хода с 1 не было. Тот же исход без
\* перезапуска: 2 принято после срока Bridge и снова встаёт в очередь за 1, пока inFlight держит
\* чат после чужой пачки. Довод спеки §3.2 «всё, что стоит перед X, было в доставке, которая
\* записала X в ledger» неверен для прямой доставки X, обогнавшей очередь. Сегодняшний слив по
\* одной голове здесь не теряет: 1 уходит своей доставкой. R1 закрывает оба пути
\* (QueueDrain-r1.cfg, а также Loop = "any" при «Перебивать» — без ошибок).
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
  N,              \* сколько сообщений
  MaxItems,       \* граница пачки в элементах (COLLECT_MAX_PARTS / COLLECT_MAX_CHARS в коде)
  MaxRestarts,    \* перезапуски Bridge
  MaxLedgerLoss,  \* сколько id ledger может потерять; 0 — не теряет
  MaxSwitches,    \* сколько раз владелец переключает «Очередь» / «Перебивать»
  Policy, Loop, Late,
  Pin, SameSender, FreshAck, AloneRule, QueueFirst

ASSUME Policy \in {"queue", "steer"}
ASSUME Loop \in {"seq", "any"}
ASSUME N \in Nat /\ MaxItems \in Nat \ {0}

Msgs == 1..N
Authors == {"a", "b"}
Kinds == {"plain", "alone"}

VARIABLES
  arrived,    \* сколько сообщений пришло; id = номер прихода
  author,     \* автор сообщения; "none" — ещё не пришло
  kind,       \* вид сообщения; "none" — ещё не пришло
  inbox,      \* inbox каждого автора (FIFO id)
  routed,     \* голова inbox автора прошла маршрут, снятие с inbox впереди
  q,          \* очередь Bridge этого чата
  busy,       \* чат занят ходом или свёрткой
  ledger,     \* id доставок, на которые eve начала ход
  phase,      \* слив: "idle" | "deliver" | "ack"
  batch,      \* пачка текущего слива
  snap,       \* снимок очереди, по которому выбрана пачка
  fresh,      \* пачка выбрана заново, не из закрепа
  pin,        \* закреп: id пачки до её снятия; {} — нет
  inflight,   \* queueInFlight содержит чат
  pol,        \* turnPolicy сейчас
  restarts, losses, switches,
  \* призраки
  seen,       \* id, которые были хотя бы в одном начатом ходе
  seenN,      \* номер первого появления в ходе; 0 — не было
  seenC,
  viaQ,       \* первое появление пришло из очереди
  enqN,       \* номер первой постановки в очередь; 0 — не было
  enqC,
  exposed,    \* id, которым дубль разрешён: их доставку оборвал перезапуск, или прямая
              \* доставка кончилась для Bridge без ответа, а eve ход начала
  dupBad,     \* был ход с id, который уже был в ходе и не exposed
  aloneBad    \* ход из очереди склеил alone с другим сообщением

inboxV == <<arrived, author, kind, inbox, routed>>
drainV == <<q, phase, batch, snap, fresh, pin, inflight>>
eveV == <<busy, ledger>>
countV == <<pol, restarts, losses, switches>>
ghostV == <<seen, seenN, seenC, viaQ, enqN, enqC, exposed, dupBad, aloneBad>>
vars == <<inboxV, drainV, eveV, countV, ghostV>>

Range(s) == {s[i] : i \in 1..Len(s)}
Max(S) == CHOOSE x \in S : \A y \in S : y <= x
Without(s, S) == SelectSeq(s, LAMBDA x : x \notin S)
InboxIds == UNION {Range(inbox[a]) : a \in Authors}

\* Пачка допустима: один элемент любого вида, или до MaxItems склеиваемых одного автора.
Valid(b) ==
  \/ Len(b) = 1
  \/ /\ Len(b) <= MaxItems
     /\ \A i \in 1..Len(b) : kind[b[i]] = "plain" /\ author[b[i]] = author[b[1]]

\* queueBatchLength: голова alone -> 1; дальше по порядку до первого alone, чужого автора или
\* границы. Пропусков нет: остановились — дальше не смотрим.
RECURSIVE Grow(_, _)
Grow(s, n) ==
  IF n = Len(s) THEN n
  ELSE LET nx == s[n + 1] IN
       IF \/ AloneRule /\ kind[nx] = "alone"
          \/ SameSender /\ author[nx] # author[s[1]]
          \/ n + 1 > MaxItems
         THEN n
         ELSE Grow(s, n + 1)
SelectLen(s) == IF AloneRule /\ kind[s[1]] = "alone" THEN 1 ELSE Grow(s, 1)

\* Сколько элементов с головы очереди стоят в закрепе (до первого не из закрепа).
PinLen == Max({k \in 0..Len(q) : \A i \in 1..k : q[i] \in pin})

\* id доставки пачки: последний элемент (joinUpdates).
Rep == batch[Len(batch)]

\* В Loop = "seq" маршрут и слив не пересекаются.
NoRouteOpen == \A a \in Authors : ~routed[a]

\* eve начала ход с доставкой b (fromQ — доставка из очереди).
Start(b, fromQ) ==
  LET new == {m \in Range(b) : m \notin seen}
      pos(m) == CHOOSE i \in 1..Len(b) : b[i] = m
      idx(m) == seenC + Cardinality({j \in 1..pos(m) : b[j] \notin seen})
  IN /\ seen' = seen \cup Range(b)
     /\ seenN' = [m \in Msgs |-> IF m \in new THEN idx(m) ELSE seenN[m]]
     /\ seenC' = seenC + Cardinality(new)
     /\ viaQ' = [m \in Msgs |-> IF m \in new THEN fromQ ELSE viaQ[m]]
     /\ dupBad' = (dupBad \/ \E m \in Range(b) : m \in seen /\ m \notin exposed)
     /\ aloneBad' = (aloneBad \/ (fromQ /\ Len(b) > 1 /\ \E i \in 1..Len(b) : kind[b[i]] = "alone"))

NoStart == UNCHANGED <<seen, seenN, seenC, viaQ, dupBad, aloneBad>>

Init ==
  /\ arrived = 0
  /\ author = [m \in Msgs |-> "none"]
  /\ kind = [m \in Msgs |-> "none"]
  /\ inbox = [a \in Authors |-> <<>>]
  /\ routed = [a \in Authors |-> FALSE]
  /\ q = <<>> /\ busy = FALSE /\ ledger = {}
  /\ phase = "idle" /\ batch = <<>> /\ snap = <<>> /\ fresh = FALSE /\ pin = {}
  /\ inflight = FALSE
  /\ pol = Policy /\ restarts = 0 /\ losses = 0 /\ switches = 0
  /\ seen = {} /\ seenN = [m \in Msgs |-> 0] /\ seenC = 0 /\ viaQ = [m \in Msgs |-> FALSE]
  /\ enqN = [m \in Msgs |-> 0] /\ enqC = 0
  /\ exposed = {} /\ dupBad = FALSE /\ aloneBad = FALSE

Arrive ==
  /\ arrived < N
  /\ \E a \in Authors, k \in Kinds :
       LET m == arrived + 1 IN
       /\ arrived' = m
       /\ author' = [author EXCEPT ![m] = a]
       /\ kind' = [kind EXCEPT ![m] = k]
       /\ inbox' = [inbox EXCEPT ![a] = Append(@, m)]
  /\ UNCHANGED <<routed, drainV, eveV, countV, ghostV>>

Enqueue(h) ==
  /\ q' = IF h \in Range(q) THEN q ELSE Append(q, h)
  /\ enqN' = IF enqN[h] = 0 THEN [enqN EXCEPT ![h] = enqC + 1] ELSE enqN
  /\ enqC' = IF enqN[h] = 0 THEN enqC + 1 ELSE enqC

Route(a) ==
  /\ inbox[a] # <<>> /\ ~routed[a]
  /\ Loop = "seq" => (phase = "idle" /\ NoRouteOpen)
  /\ LET h == Head(inbox[a])
         mustQueue == \/ inflight
                      \/ pol = "queue" /\ (busy \/ q # <<>>)
                      \/ QueueFirst /\ q # <<>>
     IN IF mustQueue
          THEN /\ Enqueue(h)
               /\ routed' = [routed EXCEPT ![a] = TRUE]
               /\ UNCHANGED <<eveV, exposed>> /\ NoStart
          ELSE /\ UNCHANGED <<q, enqN, enqC>>
               /\ IF h \in ledger
                    THEN \* handled -> delivered
                         /\ routed' = [routed EXCEPT ![a] = TRUE]
                         /\ UNCHANGED <<eveV, exposed>> /\ NoStart
                    ELSE \/ \* принято
                            /\ Start(<<h>>, FALSE)
                            /\ ledger' = ledger \cup {h} /\ busy' = TRUE
                            /\ routed' = [routed EXCEPT ![a] = TRUE]
                            /\ UNCHANGED exposed
                         \/ \* принято после срока Bridge: голова остаётся в inbox
                            /\ Late
                            /\ Start(<<h>>, FALSE)
                            /\ ledger' = ledger \cup {h} /\ busy' = TRUE
                            /\ exposed' = exposed \cup {h}
                            /\ UNCHANGED routed
  /\ UNCHANGED <<arrived, author, kind, inbox>>
  /\ UNCHANGED <<phase, batch, snap, fresh, pin, inflight>> /\ UNCHANGED countV

InboxAck(a) ==
  /\ routed[a]
  /\ inbox' = [inbox EXCEPT ![a] = Tail(@)]
  /\ routed' = [routed EXCEPT ![a] = FALSE]
  /\ UNCHANGED <<arrived, author, kind, drainV, eveV, countV, ghostV>>

StartDrain ==
  /\ phase = "idle" /\ ~busy /\ q # <<>>
  /\ Loop = "seq" => NoRouteOpen
  /\ LET pl == IF Pin THEN PinLen ELSE 0
         n == IF pl > 0 THEN pl ELSE SelectLen(q)
         b == SubSeq(q, 1, n)
     IN /\ batch' = b /\ snap' = q /\ fresh' = (pl = 0)
        /\ pin' = IF Pin THEN Range(b) ELSE {}
  /\ phase' = "deliver" /\ inflight' = TRUE
  /\ UNCHANGED <<q, inboxV, eveV, countV, ghostV>>

DrainIdle ==
  /\ phase' = "idle" /\ batch' = <<>> /\ snap' = <<>> /\ fresh' = FALSE

Deliver ==
  /\ phase = "deliver"
  /\ IF Rep \in ledger
       THEN \* handled: хода нет, снятие
            /\ phase' = "ack" /\ inflight' = FALSE
            /\ UNCHANGED <<batch, snap, fresh, eveV>> /\ NoStart
       ELSE \/ \* принято: ход, ledger, чат занят; inFlight остаётся (фаза running)
               /\ Start(batch, TRUE)
               /\ ledger' = ledger \cup {Rep} /\ busy' = TRUE
               /\ phase' = "ack"
               /\ UNCHANGED <<batch, snap, fresh, inflight>>
            \/ \* не принято: закреп остаётся
               /\ DrainIdle /\ inflight' = FALSE
               /\ UNCHANGED eveV /\ NoStart
            \/ \* принято после срока Bridge: Bridge видит false, закреп остаётся
               /\ Late
               /\ Start(batch, TRUE)
               /\ ledger' = ledger \cup {Rep} /\ busy' = TRUE
               /\ DrainIdle /\ inflight' = FALSE
  /\ UNCHANGED <<q, pin, inboxV, countV, enqN, enqC, exposed>>

Ack ==
  /\ phase = "ack"
  /\ \/ /\ q' = IF FreshAck THEN Without(q, Range(batch)) ELSE Without(snap, Range(batch))
        /\ pin' = {}
     \/ \* ACK_ROLLED_BACK: очередь прежняя, закреп остаётся
        UNCHANGED <<q, pin>>
  /\ DrainIdle
  /\ UNCHANGED <<inflight, inboxV, eveV, countV, ghostV>>

Settle ==
  /\ inflight /\ phase = "idle" /\ ~busy
  /\ Loop = "seq" => NoRouteOpen
  /\ inflight' = FALSE
  /\ UNCHANGED <<q, phase, batch, snap, fresh, pin, inboxV, eveV, countV, ghostV>>

Busy ==
  /\ ~busy /\ busy' = TRUE
  /\ UNCHANGED <<ledger, inboxV, drainV, countV, ghostV>>

Free ==
  /\ busy /\ busy' = FALSE
  /\ UNCHANGED <<ledger, inboxV, drainV, countV, ghostV>>

LedgerLoss ==
  /\ losses < MaxLedgerLoss
  /\ \E m \in ledger : ledger' = ledger \ {m}
  /\ losses' = losses + 1
  /\ UNCHANGED <<busy, pol, restarts, switches, inboxV, drainV, ghostV>>

\* Владелец переключает «Очередь» / «Перебивать» в /menu (data/settings.json).
Switch ==
  /\ switches < MaxSwitches
  /\ switches' = switches + 1
  /\ pol' = IF pol = "queue" THEN "steer" ELSE "queue"
  /\ UNCHANGED <<restarts, losses, inboxV, drainV, eveV, ghostV>>

Restart ==
  /\ restarts < MaxRestarts
  /\ restarts' = restarts + 1
  /\ exposed' = exposed \cup pin \cup Range(batch)
                \cup {Head(inbox[a]) : a \in {x \in Authors : routed[x]}}
  /\ DrainIdle /\ pin' = {} /\ inflight' = FALSE
  /\ routed' = [a \in Authors |-> FALSE]
  /\ UNCHANGED <<q, arrived, author, kind, inbox, eveV, pol, losses, switches>>
  /\ UNCHANGED <<seen, seenN, seenC, viaQ, enqN, enqC, dupBad, aloneBad>>

Next ==
  \/ Arrive
  \/ \E a \in Authors : Route(a) \/ InboxAck(a)
  \/ StartDrain \/ Deliver \/ Ack \/ Settle
  \/ Busy \/ Free \/ LedgerLoss \/ Switch \/ Restart

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ arrived \in 0..N
  /\ author \in [Msgs -> Authors \cup {"none"}]
  /\ kind \in [Msgs -> Kinds \cup {"none"}]
  /\ \A a \in Authors : Range(inbox[a]) \subseteq 1..arrived /\ Len(inbox[a]) <= N
  /\ routed \in [Authors -> BOOLEAN]
  /\ Range(q) \subseteq 1..arrived /\ Len(q) = Cardinality(Range(q))
  /\ busy \in BOOLEAN /\ ledger \subseteq Msgs
  /\ phase \in {"idle", "deliver", "ack"}
  /\ (phase = "idle") = (batch = <<>>)
  /\ pin \subseteq Msgs /\ inflight \in BOOLEAN /\ pol \in {"queue", "steer"}
  /\ seen \subseteq Msgs /\ exposed \subseteq Msgs

\* (1) Каждое пришедшее сообщение лежит в inbox, в очереди или было хотя бы в одном ходе.
NoLoss == \A m \in 1..arrived : m \in InboxIds \/ m \in Range(q) \/ m \in seen

\* (2) Сообщение бывает в двух ходах, только если оно exposed: его доставку оборвал перезапуск
\* Bridge (пачка в полёте или в закрепе, маршрут без снятия с inbox), или прямая доставка
\* кончилась для Bridge без ответа, а eve ход начала. Срок ответа слива сам дубля не даёт.
NoDupBeyondBreak == ~dupBad

\* (3) Первые появления сообщений, пришедших в ход из очереди, идут в порядке первой постановки;
\* внутри хода части — в порядке очереди.
QueueOrder ==
  \A m1, m2 \in Msgs :
    (enqN[m1] # 0 /\ enqN[m2] # 0 /\ enqN[m1] < enqN[m2] /\ seenN[m2] # 0 /\ viaQ[m2])
      => (seenN[m1] # 0 /\ seenN[m1] < seenN[m2])

\* (4) Пачка, выбранная без закрепа, — префикс снимка, допустима и максимальна: следующий
\* элемент alone, другого автора, или пачка уже MaxItems; голова alone -> пачка из неё одной.
WholeBatch ==
  (phase # "idle" /\ fresh) =>
    /\ Len(batch) <= Len(snap) /\ SubSeq(snap, 1, Len(batch)) = batch
    /\ Valid(batch)
    /\ Len(batch) < Len(snap) => ~Valid(SubSeq(snap, 1, Len(batch) + 1))

\* (5) Ход из очереди, в котором есть alone, состоит из одного сообщения.
AloneStaysAlone == ~aloneBad

\* (6) Пачка в полёте стоит с головы очереди целиком: removeQueueItems не встречает набор не с
\* головы (там код бросает ошибку без записи).
BatchAtHead ==
  phase # "idle" => (Len(q) >= Len(batch) /\ SubSeq(q, 1, Len(batch)) = batch)

\* (7) Закреп стоит с головы очереди целиком: ветка «закреп частичный или пустой» недостижима.
PinAtHead ==
  pin # {} =>
    (Len(q) >= Cardinality(pin) /\ {q[i] : i \in 1..Cardinality(pin)} = pin)
====
