---- MODULE LaunchdUnit ----
\* Юниты Ивы под launchd (.scratch/macos-install/spec.md v3, §3.1, §3.3, §7). Модель написана
\* ДО кода, по спеке: это модель дизайна шва systemctl -> launchctl, а не пересказ кода.
\*
\* Два юнита, по одной метке launchd на каждый:
\*   k — KeepAlive-сервис (Restart=always: KeepAlive, RunAtLoad, ThrottleInterval), например
\*       юзербот app.iva.iva-telegram-userbot;
\*   o — oneshot с календарём: iva-brain.timer и iva-brain.service — ОДНА метка app.iva.iva-brain.
\*       «Календарь загружен» = метка загружена; «таймер активен» = то же самое; «сервис
\*       активен» = у метки есть pid.
\* Состояние метки: unloaded | idle (загружена, процесса нет; у KeepAlive не бывает) | running |
\* throttled (KeepAlive: процесс вышел, launchd поднимет через ThrottleInterval) | stopping
\* (`state = SIGTERMed`: процесс гасится, у eve до 15–20 с; поле nx — чем станет метка, когда
\* процесс выйдет: unloaded после bootout, idle или throttled после kill). Флаг en —
\* метки нет в `launchctl print-disabled`. Флаг stale — загруженная копия плиста старше файла:
\* launchd читает плист только на bootstrap.
\*
\* Примитивы launchctl (функции над записью метки, ответ <<метка, код 0?>>):
\*   bootstrap: выключенная метка — отказ; загруженная — успех без изменений
\*              (bootstrapWhileLoaded); иначе грузит плист с диска (RunAtLoad у KeepAlive)
\*   bootout:   асинхронный (приёмка 499547ba, полосы Б, В, Д): код 0 сразу, метка с процессом
\*              переходит в stopping и выгружается, когда процесс выйдет (processExit, WF);
\*              без процесса — выгружена сразу; незагруженная — успех (код 3)
\*   bootstrap метки в stopping: код 5; `print` в этот миг видит задание (SIGTERMed), разбор
\*              «5 и загружено = уже загружено» берёт это за успех, а метка затем исчезает (113)
\*   kickstart / kickstart -k: процесс запущен; плист НЕ перечитывается; незагруженная — 113
\*   kill SIGTERM: процесс гасится (stopping), затем выходит; KeepAlive поднимет его снова;
\*              незагруженная — 113
\*              (проба на mini 17.10.2026: `launchctl kill` и `kickstart` чужой метки -> 113)
\*   enable / disable: только флаг en
\* Ожидание постусловия (spec v3.3): stop и restart ждут 113 у `print`, stop oneshot ждёт
\* исчезновения pid; в модели это processExit внутри того же шага писателя.
\* Сам launchd: crash (выход процесса), throttleExpire и processExit (честно, WF), calendarFire, вход в систему
\* (bootstrap всех плистов), выход (bootout всех).
\*
\* Действие модели -> код (имена из спеки, кода ещё нет)
\*   StopK              scripts/lib/launchd.ts runLaunchd(["stop", u])     KeepAlive -> bootout
\*   StartK             scripts/lib/launchd.ts runLaunchd(["start", u])    + ожидание running 10 с
\*   RestartK           scripts/lib/launchd.ts runLaunchd(["restart", u])  + ожидание running 10 с
\*   EnableNowK         scripts/lib/launchd.ts runLaunchd(["enable", "--now", u])
\*   DisableNowK        scripts/lib/launchd.ts runLaunchd(["disable", "--now", u])
\*   IsActiveK          scripts/lib/launchd.ts runLaunchd(["is-active", u])
\*   StopNight          scripts/lib/menu/svc-run.ts run._kill -> runLaunchd(["stop", "iva-brain.service"])
\*   StartNight         scripts/lib/menu/svc-run.ts -> runLaunchd(["start", "--no-block", "iva-brain.service"])
\*   RestartTimer       scripts/lib/plugin-units.ts / update-finish.ts restartPluginUnits ->
\*                      runLaunchd(["restart", "<plugin>.timer"])
\*   WritePlist(u)      scripts/cli/systemd.ts writeUnits (плист переписан: TZ, окружение)
\*   UpdateQuiesce      scripts/update-finish.ts captureOptionalWriterState + stopWriterUnits
\*   UpdateBody         update-finish.ts между stop и restore (writeUnits, activateUnits, миграция)
\*   RestoreStep        scripts/update-finish.ts restoreOptionalWriterState, по одному имени за шаг:
\*                      iva-brain.timer, iva-brain.service, iva-telegram-userbot.service
\*
\* Выборы, которые спека v3 оставляет открытыми или задаёт иначе, — константы. Основной конфиг
\* берёт вариант, при котором инварианты держатся; свидетели показывают, что ломает другой.
EXTENDS Naturals

CONSTANTS
  MaxSteps,          \* бюджет действий писателей и среды (throttleExpire бесплатен)
  StopKAMode,        \* "bootout" (спека) | "kill" (мутант) — stop KeepAlive-юнита
  StopOneshotMode,   \* "kill" (спека, B7) | "bootout" (мутант) — stop oneshot .service пары
  StopTimerMode,     \* "bootout" | "kill" — stop .timer: в таблице §3.1 строки нет
  KillUnloadedOk,    \* TRUE — kill незагруженной метки = успех; в спеке нет (только про bootout)
  ActiveByLoaded,    \* TRUE — is-active KeepAlive по «загружено» (мутант)
  ThrottledAnswer,   \* is-active KeepAlive в throttled: "inactive" (спека) | "activating"
  RestartKMode,      \* "kickstartK" (спека) | "reload" (bootout + bootstrap) — restart загруженного
  RestartTimerMode,  \* "kickstartK" (спека) | "reload" — restart загруженного .timer
  KeepAlive,         \* TRUE — в плисте k есть KeepAlive (FALSE — свидетель живучести)
  WaitStop,          \* TRUE — stop/disable --now/kill ждут выхода процесса (v3.3) | FALSE (499547ba)
  WaitRestart        \* TRUE — restart ждёт 113 после bootout до bootstrap (v3.3) | FALSE (499547ba)

States == {"unloaded", "idle", "running", "throttled", "stopping"}
Unit == [st : States, en : BOOLEAN, stale : BOOLEAN, nx : {"unloaded", "idle", "throttled"}]
Phases == {"idle", "quiesced", "restoring", "ok", "mismatch", "error", "quiesce-failed"}
Answers == {"none", "active", "activating", "inactive"}
Names == 1..3   \* 1 iva-brain.timer, 2 iva-brain.service (обе — метка o), 3 юзербот (метка k)

VARIABLES
  k, o,          \* метки launchd
  kStopped,      \* писатель остановил k и с тех пор не было start/restart/bootstrap
  kCrashed,      \* процесс k вышел сам и ещё не вернулся в running (и не выгружен)
  nightCancelled,\* ночь отменена из меню (stop .service), календарь с тех пор не трогали
  ans,           \* последний ответ is-active про k и состояние k в момент ответа
  staleRestart,  \* последний restart оставил загруженной старую копию плиста
  timerRan,      \* restart .timer сам запустил задание
  restartBroke,  \* restart включённой метки вернулся, а метка не работает и сама не поднимется
  upd,           \* фаза обновления
  cap,           \* снимок captureOptionalWriterState: имя -> [en, act]
  capKLoaded,    \* k была загружена (KeepAlive в ответе за неё) в момент снимка
  kLost,         \* restore кончился успехом, а k, загруженная до обновления, выгружена
  step,          \* какое имя restore обрабатывает
  budget

vars == <<k, o, kStopped, kCrashed, nightCancelled, ans, staleRestart, timerRan, restartBroke,
          upd, cap, capKLoaded, kLost, step, budget>>

Loaded(u) == u.st # "unloaded"

\* ---------- примитивы launchctl ----------
Bootstrap(u, ka) ==
  IF ~u.en THEN <<u, FALSE>>
  ELSE IF Loaded(u) THEN <<u, TRUE>>
  ELSE <<[u EXCEPT !.st = IF ka THEN "running" ELSE "idle", !.stale = FALSE], TRUE>>
\* Процесс вышел: метка становится тем, что назначил bootout или kill.
Exit(u) ==
  IF u.st # "stopping" THEN u
  ELSE [u EXCEPT !.st = u.nx, !.stale = IF u.nx = "unloaded" THEN FALSE ELSE u.stale]
BootoutRaw(u) ==
  IF u.st \in {"running", "stopping"} THEN [u EXCEPT !.st = "stopping", !.nx = "unloaded"]
  ELSE [u EXCEPT !.st = "unloaded", !.stale = FALSE]
Await(u, wait) == IF wait THEN Exit(u) ELSE u
Bootout(u) == <<Await(BootoutRaw(u), WaitStop), TRUE>>
Kickstart(u) ==
  IF Loaded(u) /\ u.st # "stopping" THEN <<[u EXCEPT !.st = "running"], TRUE>> ELSE <<u, FALSE>>
Kill(u, ka) ==
  IF ~Loaded(u) THEN <<u, KillUnloadedOk>>
  ELSE IF u.st = "stopping" THEN <<Await(u, WaitStop), TRUE>>
  ELSE IF u.st # "running" THEN <<u, TRUE>>
  ELSE <<Await([u EXCEPT !.st = "stopping",
                         !.nx = IF ka /\ KeepAlive THEN "throttled" ELSE "idle"], WaitStop), TRUE>>
Enable(u) == <<[u EXCEPT !.en = TRUE], TRUE>>
DisableNow(u) == Bootout([u EXCEPT !.en = FALSE])
Reload(u, ka) == Bootstrap(Await(BootoutRaw(u), WaitRestart), ka)
Live(u) == u.st \in {"running", "throttled"}

\* ---------- глаголы runLaunchd по таблице §3.1 ----------
\* KeepAlive: после bootstrap/kickstart ждём running до 10 с; throttled за это время истекает.
WaitRunning(r) ==
  IF r[2] /\ r[1].st \in {"running", "throttled"} /\ KeepAlive
  THEN <<[r[1] EXCEPT !.st = "running"], TRUE>>
  ELSE <<r[1], r[2] /\ r[1].st = "running">>
StopKF(u) == IF StopKAMode = "bootout" THEN Bootout(u) ELSE Kill(u, TRUE)
StartKF(u) == WaitRunning(IF Loaded(u) THEN <<u, TRUE>> ELSE Bootstrap(u, TRUE))
RestartKF(u) ==
  WaitRunning(IF ~Loaded(u) THEN Bootstrap(u, TRUE)
              ELSE IF RestartKMode = "kickstartK" THEN Kickstart(u) ELSE Reload(u, TRUE))
EnableNowKF(u) == WaitRunning(Bootstrap(Enable(u)[1], TRUE))
StopSF(u) == IF StopOneshotMode = "kill" THEN Kill(u, FALSE) ELSE Bootout(u)
StartSF(u) ==
  LET b == IF Loaded(u) THEN <<u, TRUE>> ELSE Bootstrap(u, FALSE)
  IN IF b[2] THEN Kickstart(b[1]) ELSE b
StopTF(u) == IF StopTimerMode = "bootout" THEN Bootout(u) ELSE Kill(u, FALSE)
StartTF(u) == IF Loaded(u) THEN <<u, TRUE>> ELSE Bootstrap(u, FALSE)
RestartTF(u) ==
  IF ~Loaded(u) THEN Bootstrap(u, FALSE)
  ELSE IF RestartTimerMode = "kickstartK" THEN Kickstart(u) ELSE Reload(u, FALSE)

AnsK(u) ==
  IF ActiveByLoaded THEN (IF Loaded(u) THEN "active" ELSE "inactive")
  ELSE CASE u.st = "running" -> "active"
         [] u.st \in {"throttled", "stopping"} -> ThrottledAnswer
         [] OTHER -> "inactive"
AnsS(u) == IF u.st \in {"running", "stopping"} THEN "active" ELSE "inactive"   \* есть pid
AnsT(u) == IF Loaded(u) THEN "active" ELSE "inactive"          \* .timer: метка загружена
\* unitActive в update-finish.ts: active | activating | deactivating | reloading -> true
UA(a) == a \in {"active", "activating"}

UnitOf(n, oo, kk) == IF n = 3 THEN kk ELSE oo
Ans(n, u) == CASE n = 1 -> AnsT(u) [] n = 2 -> AnsS(u) [] OTHER -> AnsK(u)
StartN(n, u) == CASE n = 1 -> StartTF(u) [] n = 2 -> StartSF(u) [] OTHER -> StartKF(u)
StopN(n, u) == CASE n = 1 -> StopTF(u) [] n = 2 -> StopSF(u) [] OTHER -> StopKF(u)
Matches(n, oo, kk) ==
  LET u == UnitOf(n, oo, kk) IN cap[n].en = u.en /\ cap[n].act = UA(Ans(n, u))

TypeOK ==
  /\ k \in Unit /\ o \in Unit
  /\ o.st # "throttled"
  /\ kStopped \in BOOLEAN /\ kCrashed \in BOOLEAN /\ nightCancelled \in BOOLEAN
  /\ ans \in [v : Answers, st : States]
  /\ staleRestart \in BOOLEAN /\ timerRan \in BOOLEAN /\ restartBroke \in BOOLEAN
  /\ upd \in Phases
  /\ cap \in [Names -> [en : BOOLEAN, act : BOOLEAN]]
  /\ capKLoaded \in BOOLEAN /\ kLost \in BOOLEAN
  /\ step \in Names
  /\ budget \in 0..MaxSteps

\* Установка: метка загружена тогда и только тогда, когда включена (вход на экране был).
Init ==
  /\ \E ke, oe \in BOOLEAN :
       /\ k = [st |-> IF ke THEN "running" ELSE "unloaded", en |-> ke, stale |-> FALSE,
               nx |-> "unloaded"]
       /\ o = [st |-> IF oe THEN "idle" ELSE "unloaded", en |-> oe, stale |-> FALSE,
               nx |-> "unloaded"]
  /\ kStopped = FALSE /\ kCrashed = FALSE /\ nightCancelled = FALSE
  /\ ans = [v |-> "none", st |-> "unloaded"]
  /\ staleRestart = FALSE /\ timerRan = FALSE /\ restartBroke = FALSE
  /\ upd = "idle"
  /\ cap = [n \in Names |-> [en |-> FALSE, act |-> FALSE]]
  /\ capKLoaded = FALSE /\ kLost = FALSE
  /\ step = 1
  /\ budget = MaxSteps

\* Пока идёт обновление (quiesce .. restore), писатели и среда не вмешиваются: restore судится
\* сам по себе. Сам launchd (throttleExpire) работает всегда.
Quiet == upd \in {"quiesced", "restoring"}
Spend == /\ budget > 0 /\ ~Quiet /\ budget' = budget - 1
UpdVars == <<upd, cap, capKLoaded, kLost, step>>

\* ---------- сам launchd и среда ----------
CrashK ==
  /\ k.st = "running" /\ Spend
  /\ k' = [k EXCEPT !.st = IF KeepAlive THEN "throttled" ELSE "idle"]
  /\ kCrashed' = TRUE
  /\ UNCHANGED <<o, kStopped, nightCancelled, ans, staleRestart, timerRan, restartBroke, UpdVars>>

\* launchd: процесс, которому послан SIGTERM, вышел (через ExitTimeOut — SIGKILL).
ProcessExit ==
  /\ \E which \in {"k", "o"} :
       IF which = "k" THEN k.st = "stopping" /\ k' = Exit(k) /\ o' = o
       ELSE o.st = "stopping" /\ o' = Exit(o) /\ k' = k
  /\ kCrashed' = (kCrashed /\ k'.st \notin {"running", "unloaded"})
  /\ UNCHANGED <<kStopped, nightCancelled, ans, staleRestart, timerRan, restartBroke, UpdVars, budget>>

ThrottleExpire ==
  /\ k.st = "throttled"
  /\ k' = [k EXCEPT !.st = "running"]
  /\ kCrashed' = FALSE
  /\ UNCHANGED <<o, kStopped, nightCancelled, ans, staleRestart, timerRan, restartBroke, UpdVars, budget>>

CalendarFire ==
  /\ o.st = "idle" /\ Spend
  /\ o' = [o EXCEPT !.st = "running"]
  /\ UNCHANGED <<k, kStopped, kCrashed, nightCancelled, ans, staleRestart, timerRan, restartBroke, UpdVars>>

NightEnds ==
  /\ o.st = "running" /\ Spend
  /\ o' = [o EXCEPT !.st = "idle"]
  /\ UNCHANGED <<k, kStopped, kCrashed, nightCancelled, ans, staleRestart, timerRan, restartBroke, UpdVars>>

\* Вход в систему: launchd делает bootstrap каждого плиста (загруженные — «уже загружено»).
Login ==
  /\ Spend
  /\ k' = Bootstrap(k, TRUE)[1]
  /\ o' = Bootstrap(o, FALSE)[1]
  /\ kStopped' = (kStopped /\ ~Loaded(k'))
  /\ kCrashed' = (kCrashed /\ ~(k'.st = "running"))
  /\ UNCHANGED <<nightCancelled, ans, staleRestart, timerRan, restartBroke, UpdVars>>

\* Выход из системы: домен gui/<uid> уходит вместе с заданиями, писателям без домена нечего
\* делать, поэтому шаг атомарен (разгрузка доведена до конца).
Logout ==
  /\ Spend
  /\ k' = Exit(BootoutRaw(k)) /\ o' = Exit(BootoutRaw(o))
  /\ kCrashed' = FALSE /\ nightCancelled' = FALSE
  /\ UNCHANGED <<kStopped, ans, staleRestart, timerRan, restartBroke, UpdVars>>

WritePlist ==
  /\ Spend
  /\ \E which \in {"k", "o"} :
       IF which = "k" THEN k' = [k EXCEPT !.stale = Loaded(k)] /\ o' = o
       ELSE o' = [o EXCEPT !.stale = Loaded(o)] /\ k' = k
  /\ UNCHANGED <<kStopped, kCrashed, nightCancelled, ans, staleRestart, timerRan, restartBroke, UpdVars>>

\* ---------- писатели вне обновления ----------
KWriter(r, stopped) ==
  /\ k' = r[1]
  /\ kStopped' = stopped
  /\ kCrashed' = (kCrashed /\ r[1].st \notin {"running", "unloaded"})

StopK ==
  /\ Spend
  /\ LET r == StopKF(k) IN
       KWriter(r, IF r[2] THEN TRUE ELSE kStopped)
  /\ UNCHANGED <<o, nightCancelled, ans, staleRestart, timerRan, restartBroke, UpdVars>>

\* start/restart возвращают 0 только при running после ожидания; вызывающий видит это как
\* is-active = active (systemd-control.ts restart -> isActive).
StartK ==
  /\ Spend
  /\ LET r == StartKF(k) IN
       /\ KWriter(r, IF r[2] THEN FALSE ELSE kStopped)
       /\ ans' = [v |-> IF r[2] THEN "active" ELSE "inactive", st |-> r[1].st]
  /\ UNCHANGED <<o, nightCancelled, staleRestart, timerRan, restartBroke, UpdVars>>

RestartK ==
  /\ Spend
  /\ LET r == RestartKF(k) IN
       /\ KWriter(r, IF r[2] THEN FALSE ELSE kStopped)
       /\ ans' = [v |-> IF r[2] THEN "active" ELSE "inactive", st |-> r[1].st]
       /\ staleRestart' = (r[2] /\ r[1].stale)
       /\ restartBroke' = (k.en /\ ~Live(r[1]))
  /\ UNCHANGED <<o, nightCancelled, timerRan, UpdVars>>

EnableNowK ==
  /\ Spend
  /\ LET r == EnableNowKF(k) IN KWriter(r, IF r[2] THEN FALSE ELSE kStopped)
  /\ UNCHANGED <<o, nightCancelled, ans, staleRestart, timerRan, restartBroke, UpdVars>>

DisableNowK ==
  /\ Spend
  /\ KWriter(DisableNow(k), TRUE)
  /\ UNCHANGED <<o, nightCancelled, ans, staleRestart, timerRan, restartBroke, UpdVars>>

IsActiveK ==
  /\ Spend
  /\ ans' = [v |-> AnsK(k), st |-> k.st]
  /\ UNCHANGED <<k, o, kStopped, kCrashed, nightCancelled, staleRestart, timerRan, restartBroke, UpdVars>>

\* Отмена ночи из меню: stop iva-brain.service.
StopNight ==
  /\ Spend
  /\ LET r == StopSF(o) IN
       /\ o' = r[1]
       /\ nightCancelled' = (nightCancelled \/ (r[2] /\ o.st \in {"idle", "running"}))
  /\ UNCHANGED <<k, kStopped, kCrashed, ans, staleRestart, timerRan, restartBroke, UpdVars>>

StartNight ==
  /\ Spend
  /\ o' = StartSF(o)[1]
  /\ UNCHANGED <<k, kStopped, kCrashed, nightCancelled, ans, staleRestart, timerRan, restartBroke, UpdVars>>

\* restart .timer плагина (новый файл юнита): календарь перечитан, задание само не запускается.
RestartTimer ==
  /\ Spend
  /\ LET r == RestartTF(o) IN
       /\ o' = r[1]
       /\ staleRestart' = (r[2] /\ r[1].stale)
       /\ timerRan' = (o.st # "running" /\ r[1].st = "running")
       /\ restartBroke' = (o.en /\ r[1].st \notin {"idle", "running"})
  /\ nightCancelled' = FALSE
  /\ UNCHANGED <<k, kStopped, kCrashed, ans, UpdVars>>

\* ---------- обновление: capture + stopWriterUnits, тело, restore ----------
\* stopWriterUnits: сначала таймеры, потом сервисы; после stop каждой группы is-active каждого
\* обязан быть false, иначе «remained active after stop». Любой ненулевой код stop — исключение.
UpdateQuiesce ==
  /\ upd = "idle" /\ Spend
  /\ cap' = [n \in Names |->
               [en |-> UnitOf(n, o, k).en, act |-> UA(Ans(n, UnitOf(n, o, k)))]]
  /\ capKLoaded' = Loaded(k)
  /\ LET t == StopTF(o)
         tOk == t[2] /\ ~UA(AnsT(t[1]))
         s == StopSF(t[1])
         kk == StopKF(k)
         sOk == s[2] /\ kk[2] /\ ~UA(AnsS(s[1])) /\ ~UA(AnsK(kk[1]))
     IN /\ o' = IF tOk THEN s[1] ELSE t[1]
        /\ k' = IF tOk /\ s[2] THEN kk[1] ELSE k
        /\ upd' = IF tOk /\ sOk THEN "quiesced" ELSE "quiesce-failed"
        /\ kStopped' = (kStopped \/ (tOk /\ s[2] /\ kk[2]))
        /\ kCrashed' = (kCrashed /\ k'.st \notin {"running", "unloaded"})
  /\ nightCancelled' = FALSE
  /\ UNCHANGED <<ans, staleRestart, timerRan, restartBroke, kLost, step>>

\* Тело обновления (writeUnits, activateUnits, миграция) может поменять флаги enabled.
UpdateBody ==
  /\ upd = "quiesced"
  /\ \E ke, oe \in BOOLEAN :
       /\ k' = [k EXCEPT !.en = ke]
       /\ o' = [o EXCEPT !.en = oe]
  /\ upd' = "restoring" /\ step' = 1
  /\ UNCHANGED <<kStopped, kCrashed, nightCancelled, ans, staleRestart, timerRan, restartBroke,
                 cap, capKLoaded, kLost, budget>>

\* restoreOptionalWriterState для одного имени: enabled, затем active, затем сверка.
RestoreStep ==
  /\ upd = "restoring"
  /\ LET n == step
         u0 == UnitOf(n, o, k)
         c == cap[n]
         r1 == IF c.en = u0.en THEN <<u0, TRUE>>
               ELSE IF c.en THEN Enable(u0) ELSE DisableNow(u0)
         u1 == r1[1]
         r2 == IF ~r1[2] \/ c.act = UA(Ans(n, u1)) THEN r1
               ELSE IF c.act THEN StartN(n, u1) ELSE StopN(n, u1)
         u2 == r2[1]
         good == r2[2] /\ c.en = u2.en /\ c.act = UA(Ans(n, u2))
         o2 == IF n = 3 THEN o ELSE u2
         k2 == IF n = 3 THEN u2 ELSE k
     IN /\ o' = o2 /\ k' = k2
        /\ upd' = IF ~good THEN "error"
                  ELSE IF n < 3 THEN "restoring"
                  ELSE IF \A m \in Names : Matches(m, o2, k2) THEN "ok" ELSE "mismatch"
        /\ step' = IF good /\ n < 3 THEN n + 1 ELSE n
        /\ kLost' = (good /\ n = 3 /\ capKLoaded /\ ~Loaded(k2))
        /\ kStopped' = IF n = 3 THEN ~Loaded(k2) ELSE kStopped
  /\ UNCHANGED <<kCrashed, nightCancelled, ans, staleRestart, timerRan, restartBroke, cap, capKLoaded, budget>>

Next ==
  \/ CrashK \/ ThrottleExpire \/ ProcessExit \/ CalendarFire \/ NightEnds \/ Login \/ Logout \/ WritePlist
  \/ StopK \/ StartK \/ RestartK \/ EnableNowK \/ DisableNowK \/ IsActiveK
  \/ StopNight \/ StartNight \/ RestartTimer
  \/ UpdateQuiesce \/ UpdateBody \/ RestoreStep

Spec == Init /\ [][Next]_vars /\ WF_vars(ThrottleExpire) /\ WF_vars(ProcessExit)

\* ---------- инварианты §7 ----------
\* (1) После stop KeepAlive-юнит не поднимается сам, пока не было start/restart/bootstrap.
NoSelfStart == kStopped => k.st # "running"

\* (2) Вызывающий видит is-active = active (в том числе как код 0 restart) только при running.
ActiveOnlyRunning == ans.v = "active" => ans.st = "running"

\* (3) restore кончается совпадением enabled/active со снимком или ошибкой; третьего нет.
RestoreExact == upd # "mismatch"

\* (B7) После stop oneshot (отмена ночи) календарь цел: следующая ночь придёт.
CalendarKept == nightCancelled => Loaded(o)

\* ---------- инварианты, найденные при моделировании (расхождения со спекой) ----------
\* stopWriterUnits проходит из любого достижимого состояния: иначе каждое обновление на Mac
\* падает до флипа.
QuiesceStops == upd # "quiesce-failed"

\* Обновление не выключает KeepAlive-юнит, который был загружен (в том числе в throttled).
KeepAliveSurvivesUpdate == ~kLost

\* restart, вернувший 0, работает по текущему плисту, а не по копии с прошлого bootstrap.
RestartLoadsPlist == ~staleRestart

\* После restart включённой метки она работает: KeepAlive — running или throttled, календарь —
\* загружен. Без ожидания 113 bootstrap попадает в stopping, и метка исчезает.
RestartWorks == ~restartBroke

\* После stopWriterUnits и до restore ни один писатель не работает и не гасится.
WritersStopped == upd = "quiesced" => /\ k.st \notin {"running", "stopping"}
                                      /\ o.st \notin {"running", "stopping"}

\* restart .timer не запускает задание (на systemd он только перевзводит таймер).
TimerVerbNoRun == ~timerRan

\* (4) Живучесть: KeepAlive-юнит после crash возвращается в running (или его выгрузили).
CrashRecovers == [](kCrashed => <>(k.st \in {"running", "unloaded"}))
====
