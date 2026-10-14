---- MODULE GoalCheck ----
\* Goal v3.2, §3.2–3.7, §4, §7; design before implementation.
\* All table changes are one Commit under the helpers.json lock. The two
\* persistence clients model the stages of saving under that same table lock.
\* SPEC-FIX-1: read/compare/rename and saved use the helpers.json lock, as does G9.
\* SPEC-FIX-2: Due needs recurring-opportunity fairness (SF), because quiet hours,
\* day normalization and competing rows can disable it between every pair of ticks.
\* CheckReleased is per captured row, including removal by G9;
\* immediate re-capture can keep the Boolean check != 0 true forever.
\* DueServed counts OwnerNextCheck/WatchNudge as rescheduling;
\* their permitted future deadline supersedes the previously due deadline.
\* SPEC-FIX-3: rule 4 keeps the owner's next time; OwnerNextKept covers all rules.
\* raw/client/session are observations of the helper lifecycle; durable outcome
\* and the goal snapshot are written only by Settle (or pending owner cancel).
\* Mode bounds environment input: capacity observes a finite disk outage and
\* no owner closure; history has news/empty, failure has blocked/empty, day
\* has quiet/empty. Other configurations exercise the omitted inputs.
EXTENDS Naturals, Integers, FiniteSets, TLC
CONSTANTS ActiveGoals, RowIds, MaxAlloc, MaxEdits, Faults, Mode, Mutant,
              SerializeLast, OpportunityFair, TrackSafety
Goals == {1, 2}
ASSUME ActiveGoals \subseteq Goals /\ ActiveGoals # {}
ASSUME RowIds \subseteq 1..4 /\ RowIds # {}
ASSUME MaxAlloc \in 0..3 /\ MaxEdits \in 0..2 /\ Faults \in 0..1
ASSUME {SerializeLast, OpportunityFair, TrackSafety} \subseteq BOOLEAN
Clients == {1, 2}
GoalRowsMax == 3
TotalRowsMax == 4
FailuresToPause == 2
DayMax == 2
None == "none"
Verdicts == {"quiet", "news", "question", "doneEv", "doneNoEv", "blocked"}
Content == {"news", "question", "done"}
SafetyNames == {"ClaimOnlyActive", "CancelChangesNothing", "OwnerNextKept",
     "ContentReportTold", "SilentBranches", "FailureCount", "NoStaleNotice",
     "ClosedMeansClosed", "NoSweepBeforeSaved", "LastSavedMonotone",
     "GoalOutlivesRows", "OnlyOwnerActs", "DayCountBounded"}
EmptyGoal == [status |-> "absent", rev |-> 1, check |-> 0, report |-> None, reportNext |-> FALSE,
     owes |-> 0, pause |-> None, due |-> "none", arrived |-> FALSE, ownerNext |-> FALSE,
     planBy |-> 0, overCeiling |-> FALSE, expired |-> FALSE, checksDay |-> 0,
     checksToday |-> 0, failures |-> 0, lastSaved |-> 0, edits |-> 0,
     allocated |-> 0, service |-> 0, pauseTicket |-> 0, pauseTold |-> 0]
\* Loaded prefix: two quiet checks were swept on the previous day.
LoadedDayGoal == [EmptyGoal EXCEPT !.status="active",!.due="default",
    !.arrived=TRUE,!.planBy=1,!.checksDay=1,!.checksToday=DayMax]
EmptyRow == [goal |-> 0, kind |-> "check", rev |-> 1, phase |-> "unused",
     told |-> FALSE, stop |-> None, outcome |-> None, snapshot |-> None,
     partial |-> FALSE, pause |-> None, saved |-> FALSE, hasText |-> FALSE,
     session |-> None, client |-> None, finishedAt |-> 0, pauseTicket |-> 0, raw |-> None]
EmptyIO == [stage |-> "idle", row |-> 0, goal |-> 0, seen |-> 0]
VARIABLES s, audit
vars == <<s, audit>>
Rows(x) == {r \in RowIds : x.r[r].phase \notin {"unused", "removed"}}
Untold(x,g) == {r \in Rows(x) : x.r[r].goal = g /\ x.r[r].phase = "outcome" /\ ~x.r[r].told}
Live(x,g) == {r \in Rows(x) : x.r[r].goal = g /\ x.r[r].kind = "check" /\ x.r[r].phase \in {"pending", "running"}}
Available(x) == RowIds \ {r \in RowIds : x.r[r].phase # "unused"}
Stamp(x,r) == IF r = 0 THEN 0 ELSE x.r[r].finishedAt
HasContent(x,r) == x.r[r].snapshot \in Content
Space(x) == Cardinality(Rows(x)) < GoalRowsMax /\ Cardinality(Rows(x)) + x.normal < TotalRowsMax
Cancel(x,r) == LET g == x.r[r].goal IN
     x.g[g].status = "closed" \/ x.r[r].rev # x.g[g].rev \/ x.r[r].raw = "stopped"
Rule(x,r) == LET g == x.r[r].goal IN
     CASE Cancel(x,r) -> 0
 [] x.g[g].report \in {"news", "question", "doneEv", "doneNoEv"} -> 1
 [] x.g[g].report = "quiet" /\ x.r[r].raw \in {"done", "empty"} -> 2
 [] x.g[g].report = None /\ x.r[r].raw = "done" /\ x.r[r].hasText -> 3
 [] OTHER -> 4
Verdict(x,g) == CASE x.g[g].report = "doneEv" -> "done"
 [] x.g[g].report = "doneNoEv" -> "news"
 [] OTHER -> x.g[g].report
\* Transition predicates are evaluated against BEFORE and AFTER, then retained
\* cumulatively. Thus TLC reports the first offending atomic transition by name.
Safe(x,y,a,g,r,n) ==
     CASE n = "ClaimOnlyActive" -> (a = "Due" =>
       (x.g[g].status = "active" /\ x.g[g].check = 0 /\ x.g[g].owes = 0 /\ Untold(x,g) = {}))
 [] n = "CancelChangesNothing" -> (a = "Settle" /\ Cancel(x,r) =>
       <<y.g[g].status,y.g[g].planBy,y.g[g].due,y.g[g].arrived,y.g[g].failures>> =
       <<x.g[g].status,x.g[g].planBy,x.g[g].due,x.g[g].arrived,x.g[g].failures>>)
 [] n = "OwnerNextKept" -> (a = "Settle" /\ x.g[g].ownerNext /\ y.g[g].status = "active" => y.g[g].due = "owner")
 [] n = "ContentReportTold" -> (a = "Settle" /\ Rule(x,r) = 1 =>
       y.r[r].phase = "outcome" /\ y.r[r].snapshot = Verdict(x,g))
 [] n = "SilentBranches" -> (a = "Settle" /\ (Rule(x,r) \in {0,2} \/
       (Rule(x,r) = 4 /\ x.g[g].failures + 1 < FailuresToPause)) => y.r[r].phase # "outcome")
 [] n = "FailureCount" -> (a = "Settle" =>
       y.g[g].failures = CASE Rule(x,r) = 4 -> x.g[g].failures + 1
                       [] Rule(x,r) \in {1,2,3} -> 0 [] OTHER -> x.g[g].failures)
 [] n = "NoStaleNotice" -> (a = "CreateNotice" =>
       x.g[g].status = "paused" /\ x.g[g].owes = x.g[g].rev /\ y.r[r].rev = x.g[g].owes)
 [] n = "ClosedMeansClosed" -> (\A h \in Goals :
       x.g[h].status = "closed" => y.g[h].status \in {"closed","removed"})
 [] n = "NoSweepBeforeSaved" -> (a = "SweepRow" /\ HasContent(x,r) =>
       x.r[r].saved /\ Stamp(x,x.g[g].lastSaved) >= x.r[r].finishedAt)
 [] n = "LastSavedMonotone" -> (\A h \in Goals :
       Stamp(y,y.g[h].lastSaved) >= Stamp(x,x.g[h].lastSaved))
 [] n = "GoalOutlivesRows" -> (a = "SweepGoal" =>
       {q \in Rows(x) : x.r[q].goal = g} = {})
 [] n = "OnlyOwnerActs" -> (\A h \in Goals :
       ((y.g[h].status = "closed" /\ x.g[h].status # "closed") \/
        (y.g[h].status = "active" /\ x.g[h].status # "active") \/
        y.g[h].rev > x.g[h].rev) => a \in {"Start","OwnerEdit","OwnerResume","OwnerClose"})
 [] n = "DayCountBounded" -> (a = "Due" => y.actual[g] <= DayMax)
 [] OTHER -> FALSE
Commit(y,a,g,r) ==
 /\ s' = y
 /\ audit' = IF ~TrackSafety THEN audit ELSE
     [n \in SafetyNames |-> audit[n] /\ Safe(s,y,a,g,r,n)]
Init ==
 /\ s = [g |-> [g \in Goals |-> IF Mode="day" /\ g=1 THEN LoadedDayGoal ELSE EmptyGoal], r |-> [r \in RowIds |-> EmptyRow],
     writers |-> [c \in Clients |-> EmptyIO], day |-> 0, quietHour |-> FALSE, normal |-> 0,
     ends |-> 0, crashes |-> 0, diskFails |-> 0, split |-> 0,
     actual |-> [g \in Goals |-> 0]]
 /\ audit = [n \in SafetyNames |-> TRUE]
Start(g) ==
 /\ g \in ActiveGoals /\ s.g[g].status = "absent"
 /\ Commit([s EXCEPT !.g[g] = [@ EXCEPT !.status="active", !.due="owner",
     !.arrived=TRUE, !.ownerNext=TRUE, !.checksDay=s.day, !.checksToday=0]],"Start",g,0)
NormalizeDay(g) ==
 /\ s.g[g].status \notin {"absent","removed"}
 /\ s.g[g].checksDay # s.day /\ Mutant # "nonormalize"
 /\ Commit([s EXCEPT !.g[g].checksDay=s.day, !.g[g].checksToday=0],"NormalizeDay",g,0)
Due(g) ==
 /\ s.g[g].status="active" /\ s.g[g].arrived /\ Mode # "limits"
 /\ (s.g[g].check=0 \/ Mutant="doublecheck")
 /\ s.g[g].owes=0 /\ Untold(s,g)={} /\ ~s.quietHour
 /\ (IF s.g[g].checksDay # s.day /\ Mutant # "nonormalize" THEN 0 ELSE s.g[g].checksToday) < DayMax
 /\ s.g[g].allocated < MaxAlloc /\ Space(s) /\ Available(s) # {}
 /\ LET r == CHOOSE q \in Available(s) : TRUE IN
     Commit([s EXCEPT !.g[g].check=r, !.g[g].report=None, !.g[g].reportNext=FALSE,
     !.g[g].checksDay=s.day,
     !.g[g].checksToday=(IF s.g[g].checksDay # s.day /\ Mutant # "nonormalize" THEN 0 ELSE @)+1, !.g[g].allocated=@+1, !.g[g].service=@+1,
     !.g[g].due="default", !.g[g].arrived=FALSE, !.g[g].ownerNext=FALSE,
     !.actual[g]=@+1, !.split=IF Mutant="split" THEN r ELSE @,
     !.r[r]=IF Mutant="split" THEN @ ELSE [EmptyRow EXCEPT
     !.goal=g, !.rev=s.g[g].rev, !.phase="pending"]],"Due",g,r)
FinishSplit ==
 /\ s.split # 0
 /\ LET r == s.split g == CHOOSE h \in Goals : s.g[h].check=r IN
     Commit([s EXCEPT !.r[r]=[EmptyRow EXCEPT !.goal=g,!.rev=s.g[g].rev,!.phase="pending"],
     !.split=0],"FinishSplit",g,r)
Claim(r) ==
 /\ s.r[r].phase="pending" /\ s.g[s.r[r].goal].status="active"
 /\ Commit([s EXCEPT !.r[r].phase="running", !.r[r].client="live",
     !.g[s.r[r].goal].rev=IF Mutant="claim-rev" THEN @+1 ELSE @],"Claim",s.r[r].goal,r)
\* The server hook can record the id and report after the HTTP client dies;
\* restart ends every old server turn, including one without a recorded id.
RecordSession(r) ==
 /\ s.r[r].phase="running" /\ s.r[r].session=None
 /\ Commit([s EXCEPT !.r[r].session="live"],"RecordSession",s.r[r].goal,r)
Report(r,v) ==
 /\ s.r[r].phase="running" /\ s.r[r].session="live"
 /\ s.r[r].raw=None /\ s.g[s.r[r].goal].check=r
 /\ s.r[r].rev=s.g[s.r[r].goal].rev
  /\ v \in (IF Mode \in {"capacity","history"} THEN {"news"} ELSE IF Mode="failure" THEN {"blocked"} ELSE IF Mode="day" THEN {"quiet"} ELSE Verdicts)
 /\ \E hint \in (IF Mode \in {"capacity","history","failure","day"} THEN {TRUE} ELSE BOOLEAN) :
     /\ (s.g[s.r[r].goal].report # v \/ s.g[s.r[r].goal].reportNext # hint)
     /\ Commit([s EXCEPT !.g[s.r[r].goal].report=v,!.g[s.r[r].goal].reportNext=hint],"Report",s.r[r].goal,r)
Stop(r,why) ==
 /\ s.r[r].phase="running" /\ s.r[r].stop=None
 /\ Mode \notin {"capacity","history","failure","day"}
 /\ Commit([s EXCEPT !.r[r].stop=why,
     !.r[r].raw=IF s.r[r].raw # None THEN why ELSE @],"Stop",s.r[r].goal,r)
StopByDeadline(r) == Stop(r,"deadline")
StopByCeiling(r) == Stop(r,"ceiling")
EndAfterCrash(r) == CASE s.r[r].stop="closed" -> "stopped"
 [] s.r[r].stop # None -> s.r[r].stop [] OTHER -> "interrupted"
ProcessDies(r) ==
 /\ s.r[r].phase="running" /\ s.r[r].client="live" /\ s.crashes<Faults
 /\ Commit([s EXCEPT !.r[r].client="dead",
     !.r[r].raw=IF s.r[r].raw # None THEN EndAfterCrash(r) ELSE @, !.crashes=@+1],"ProcessDies",s.r[r].goal,r)
ServerRestart ==
 /\ s.crashes<Faults
 /\ Commit([s EXCEPT !.crashes=@+1, !.split=0,
     !.r=[r \in RowIds |-> [s.r[r] EXCEPT
     !.client=IF s.r[r].phase="running" THEN "dead" ELSE @,
     !.raw=IF s.r[r].phase="running" /\ s.r[r].raw # None THEN EndAfterCrash(r) ELSE @,
     !.session=IF s.r[r].phase="running" THEN "ended" ELSE @]],
     !.writers=[c \in Clients |-> EmptyIO]],"ServerRestart",0,0)
ConfirmEnd(r) ==
 /\ s.r[r].phase="running" /\ s.r[r].raw=None
 /\ (Mode # "capacity" \/ s.g[s.r[r].goal].report # None)
 /\ \E result \in (IF Mode \in {"capacity","history","failure","day"} THEN {"empty"} ELSE {"done","empty","failed"}) :
     \E text \in (IF Mode \in {"capacity","history","failure","day"} THEN {FALSE} ELSE BOOLEAN) :
     LET out == CASE s.r[r].stop="closed" -> "stopped"
         [] s.r[r].stop # None -> s.r[r].stop
         [] s.r[r].client="dead" \/ s.r[r].session="ended" -> "interrupted"
         [] OTHER -> result IN
     Commit([s EXCEPT !.r[r].raw=out, !.r[r].hasText=text,
     !.r[r].session="ended"],"ConfirmEnd",s.r[r].goal,r)
ActualCancel(r) == LET g == s.r[r].goal IN
     (s.g[g].status="closed" /\ ~(Mutant="noclosed" /\ s.r[r].stop="deadline"))
     \/ (s.r[r].rev # s.g[g].rev /\ Mutant # "norev")
     \/ s.r[r].raw="stopped"
ActualRule(r) == LET g == s.r[r].goal IN
     CASE ActualCancel(r) -> 0
 [] s.g[g].report \in {"news","question","doneEv","doneNoEv"} /\
        ~(Mutant="require-done" /\ s.r[r].raw # "done") -> 1
 [] s.g[g].report="quiet" /\ s.r[r].raw \in {"done","empty"} /\
        ~(Mutant="quiet-empty" /\ s.r[r].raw="empty") -> 2
 [] s.g[g].report=None /\ s.r[r].raw="done" /\ s.r[r].hasText -> 3
 [] OTHER -> 4
Settle(r) ==
 /\ s.r[r].phase \in {"pending","running"} /\ s.r[r].raw # None
 /\ s.g[s.r[r].goal].check=r
 /\ LET g == s.r[r].goal k == ActualRule(r)
     f == IF k=4 THEN s.g[g].failures+1 ELSE IF k=0 THEN s.g[g].failures ELSE 0
     paused == k=4 /\ f>=FailuresToPause
     done == k=1 /\ s.g[g].report="doneEv"
     content == k \in {1,3}
     snap == IF content THEN IF k=3 THEN "news" ELSE Verdict(s,g)
             ELSE IF paused THEN "paused" ELSE None
     ownerDue == s.g[g].ownerNext /\ Mutant # "owner-time"
     status == IF k=0 THEN s.g[g].status ELSE IF done THEN "proposed" ELSE IF paused THEN "paused" ELSE "active"
     IN Commit([s EXCEPT !.ends=@+1,
     !.g[g].status=status, !.g[g].check=0, !.g[g].report=None, !.g[g].reportNext=FALSE,
     !.g[g].planBy=IF k \in {1,2,3} THEN s.r[r].rev ELSE @,
     !.g[g].failures=IF Mutant="content-failure" /\ k=1 /\ s.r[r].raw \notin {"done","empty"} THEN 1 ELSE f,
     !.g[g].pause=IF paused THEN "failures" ELSE @,
     !.g[g].pauseTicket=IF paused THEN @+1 ELSE @,
     !.g[g].due=IF k=0 THEN @ ELSE IF status # "active" THEN "none"
        ELSE IF k=4 THEN IF ownerDue /\ Mutant # "fail-default" THEN @ ELSE "default"
        ELSE IF ownerDue THEN @
     ELSE IF k \in {1,2} /\ s.g[g].reportNext THEN "helper" ELSE "default",
     !.g[g].arrived=IF k=0 \/ (ownerDue /\ status="active") THEN @ ELSE FALSE,
     !.r[r].phase=IF content \/ paused THEN "outcome" ELSE "closed",
     !.r[r].outcome=s.r[r].raw, !.r[r].snapshot=snap,
     !.r[r].partial=content /\ s.r[r].raw \notin {"done","empty"},
     !.r[r].pause=IF paused THEN "failures" ELSE None,
     !.r[r].pauseTicket=IF paused THEN s.g[g].pauseTicket+1 ELSE 0,
     !.r[r].saved=~content, !.r[r].finishedAt=s.ends+1],"Settle",g,r)
PauseByLimit(g) ==
 /\ s.g[g].status="active" /\ s.g[g].check=0
 /\ (s.g[g].expired \/ s.g[g].overCeiling)
 /\ Commit([s EXCEPT !.g[g].status="paused", !.g[g].due="none", !.g[g].arrived=FALSE,
     !.g[g].pause=IF s.g[g].expired THEN "expired" ELSE "ceiling", !.g[g].owes=s.g[g].rev,
     !.g[g].pauseTicket=@+1, !.g[g].service=@+1],"PauseByLimit",g,0)
CreateNotice(g) ==
 /\ s.g[g].owes # 0 /\ (Untold(s,g)={} \/ Mutant="notice-untold")
 /\ Space(s) /\ Available(s) # {}
 /\ LET r == CHOOSE q \in Available(s) : TRUE IN
     Commit([s EXCEPT !.ends=@+1, !.g[g].owes=0,
     !.r[r]=[EmptyRow EXCEPT !.goal=g,!.kind="notice",!.rev=s.g[g].owes,
     !.phase="outcome",!.outcome="empty",!.saved=TRUE,!.snapshot="paused",
     !.pause=s.g[g].pause,!.pauseTicket=s.g[g].pauseTicket,!.finishedAt=s.ends+1]],"CreateNotice",g,r)
\* Pending owner cancellation finalizes together with G6/G8. Running rows keep
\* the first stop reason, including deadline before OwnerClose, until Settle.
OwnerRows(g,close) == [r \in RowIds |->
     IF s.r[r].goal # g THEN s.r[r] ELSE
     [s.r[r] EXCEPT
     !.phase=IF s.r[r].phase="pending" /\ Mutant # "pending-close" THEN "closed"
     ELSE IF s.r[r].phase="outcome" /\ ~s.r[r].told /\
       ~(close /\ Mutant="close-untold") THEN "closed" ELSE @,
     !.stop=IF s.r[r].phase \in {"pending","running"} /\ s.r[r].stop=None THEN "closed" ELSE @,
     !.raw=IF s.r[r].phase="pending" /\ Mutant # "pending-close" THEN "stopped"
     ELSE IF s.r[r].phase="running" /\ s.r[r].raw # None /\ s.r[r].stop=None THEN "stopped" ELSE @,
     !.outcome=IF s.r[r].phase="pending" /\ Mutant # "pending-close" THEN "stopped" ELSE @,
     !.saved=IF s.r[r].phase="pending" /\ Mutant # "pending-close" THEN TRUE ELSE @,
     !.finishedAt=IF s.r[r].phase="pending" /\ Mutant # "pending-close" THEN s.ends+1 ELSE @]]
Pending(g) == s.g[g].check # 0 /\ s.r[s.g[g].check].phase="pending" /\ Mutant # "pending-close"
OwnerEdit(g) ==
 /\ s.g[g].status \in {"active","proposed","paused"} /\ s.g[g].edits<MaxEdits
 /\ s.g[g].rev<3
 /\ Commit([s EXCEPT !.ends=IF Pending(g) THEN @+1 ELSE @,
     !.g[g].check=IF Pending(g) THEN 0 ELSE @,
     !.g[g].report=IF Pending(g) THEN None ELSE @, !.g[g].rev=@+1, !.g[g].edits=@+1, !.g[g].planBy=s.g[g].rev+1,
     !.g[g].status="active", !.g[g].pause=None, !.g[g].owes=IF Mutant="edit-owes" THEN @ ELSE 0,
     !.g[g].failures=IF s.g[g].status \in {"paused","proposed"} THEN 0 ELSE @,
     !.g[g].expired=IF s.g[g].status \in {"paused","proposed"} THEN FALSE ELSE @,
     !.g[g].overCeiling=IF s.g[g].status \in {"paused","proposed"} THEN FALSE ELSE @,
     !.g[g].due="owner", !.g[g].arrived=TRUE, !.g[g].ownerNext=TRUE,
     !.g[g].service=@+1, !.r=OwnerRows(g,FALSE)],"OwnerEdit",g,0)
OwnerResume(g) ==
 /\ s.g[g].status \in {"paused","proposed"} /\ s.g[g].edits<MaxEdits
 /\ Commit([s EXCEPT !.g[g].status="active", !.g[g].pause=None, !.g[g].owes=0,
     !.g[g].failures=0, !.g[g].expired=FALSE, !.g[g].overCeiling=FALSE,
     !.g[g].due="owner", !.g[g].arrived=TRUE, !.g[g].ownerNext=TRUE,
     !.g[g].edits=@+1, !.g[g].service=@+1],"OwnerResume",g,0)
OwnerNextCheck(g) ==
 /\ s.g[g].status="active" /\ s.g[g].edits<MaxEdits
 /\ Commit([s EXCEPT !.g[g].due="owner",!.g[g].arrived=FALSE,!.g[g].ownerNext=TRUE,
     !.g[g].edits=@+1,!.g[g].service=@+1],"OwnerNextCheck",g,0)
OwnerClose(g) ==
 /\ Mode # "capacity"
 /\ s.g[g].status \in {"active","proposed","paused"}
 /\ Commit([s EXCEPT !.ends=IF Pending(g) THEN @+1 ELSE @,
     !.g[g].check=IF Pending(g) THEN 0 ELSE @,
     !.g[g].report=IF Pending(g) THEN None ELSE @, !.g[g].status="closed",!.g[g].report=None,!.g[g].reportNext=FALSE,!.g[g].owes=0,
     !.g[g].due="none",!.g[g].arrived=FALSE,!.g[g].pause=None,
     !.g[g].service=@+1,!.r=OwnerRows(g,TRUE)],"OwnerClose",g,0)
WatchNudge(g) ==
 /\ s.g[g].status="active" /\ s.g[g].check=0
 /\ s.g[g].allocated<MaxAlloc /\ ~s.g[g].arrived
 /\ Commit([s EXCEPT !.g[g].due="owner",!.g[g].arrived=TRUE,!.g[g].ownerNext=TRUE,
     !.g[g].service=@+1],"WatchNudge",g,0)
Tell(r) ==
 /\ s.r[r].phase="outcome" /\ ~s.r[r].told
 /\ LET g == s.r[r].goal IN Commit([s EXCEPT !.r[r].told=TRUE,
     !.g[g].pauseTold=IF s.r[r].snapshot="paused" THEN IF s.r[r].pauseTicket > @ THEN s.r[r].pauseTicket ELSE @ ELSE @],"Tell",g,r)
PersistEligible(r) == HasContent(s,r) /\ ~s.r[r].saved /\
     (s.r[r].told \/ s.r[r].phase="closed") /\ s.r[r].phase # "removed"
PersistRead(c,r) ==
 /\ Mode # "capacity"
 /\ s.writers[c].stage="idle" /\ PersistEligible(r)
 /\ (~SerializeLast \/ \A d \in Clients : s.writers[d].goal # s.r[r].goal \/ s.writers[d].stage \notin {"read","write"})
 /\ LET g == s.r[r].goal IN
         Commit([s EXCEPT !.writers[c]=[stage |-> "read",row |-> r,goal |-> g,
     seen |-> Stamp(s,s.g[g].lastSaved)]],"PersistRead",g,r)
PersistLast(c) ==
 /\ s.writers[c].stage="read"
 /\ LET r == s.writers[c].row g == s.writers[c].goal IN
     Commit([s EXCEPT !.writers[c].stage="mark",
     !.g[g].lastSaved=IF Mutant="no-compare" \/ s.writers[c].seen<s.r[r].finishedAt THEN r ELSE @],"PersistLast",g,r)
PersistMark(c) ==
 /\ s.writers[c].stage="mark"
 /\ LET r == s.writers[c].row g == s.writers[c].goal IN
     Commit([s EXCEPT !.r[r].saved=TRUE,!.writers[c]=EmptyIO],"PersistMark",g,r)
PersistFail(c) ==
 /\ s.writers[c].stage # "idle" /\ s.diskFails<Faults
 /\ Commit([s EXCEPT !.diskFails=@+1,!.writers[c]=EmptyIO],"PersistFail",s.writers[c].goal,s.writers[c].row)
SweepRow(r) ==
 /\ s.r[r].phase \in {"closed","outcome"}
 /\ (s.r[r].phase="closed" \/ s.r[r].told)
 /\ (s.r[r].saved \/ Mutant="sweep-unsaved")
  /\ Commit([s EXCEPT !.r[r].phase="removed"],"SweepRow",s.r[r].goal,r)
SweepGoal(g) ==
 /\ s.g[g].status="closed" /\ s.g[g].check=0
 /\ {r \in Rows(s) : s.r[r].goal=g}={}
 /\ (~SerializeLast \/ \A c \in Clients : s.writers[c].goal # g \/ s.writers[c].stage="mark")
 /\ Commit([s EXCEPT !.g[g].status="removed"],"SweepGoal",g,0)
DayPasses == Commit([s EXCEPT !.day=1-@,!.actual=[g \in Goals |-> 0]],"DayPasses",0,0)
QuietOn ==
 /\ ~s.quietHour /\ Commit([s EXCEPT !.quietHour=TRUE],"QuietOn",0,0)
QuietOff ==
 /\ s.quietHour /\ Commit([s EXCEPT !.quietHour=FALSE],"QuietOff",0,0)
HelperRowAdd ==
 /\ s.normal=0 /\ Cardinality(Rows(s))<TotalRowsMax
 /\ Commit([s EXCEPT !.normal=1],"HelperRowAdd",0,0)
HelperRowDrop ==
 /\ s.normal=1 /\ Commit([s EXCEPT !.normal=0],"HelperRowDrop",0,0)
Arrive(g) ==
 /\ s.g[g].status="active" /\ ~s.g[g].arrived /\ s.g[g].allocated<MaxAlloc
 /\ Commit([s EXCEPT !.g[g].arrived=TRUE],"Arrive",g,0)
LimitReached(g) ==
 /\ s.g[g].status="active" /\ ~s.g[g].expired /\ ~s.g[g].overCeiling
 /\ Mode \notin {"day","capacity","history","check","failure"} /\ \E why \in {"expired","ceiling"} :
     Commit([s EXCEPT !.g[g].expired=why="expired",!.g[g].overCeiling=why="ceiling"],"LimitReached",g,0)
Next ==
 /\ TRUE
 /\ (DayPasses \/ QuietOn \/ QuietOff \/ HelperRowAdd \/ HelperRowDrop \/ ServerRestart \/ FinishSplit
     \/ (\E g \in Goals : Start(g) \/ NormalizeDay(g) \/ Due(g) \/ PauseByLimit(g) \/ CreateNotice(g)
         \/ OwnerEdit(g) \/ OwnerResume(g) \/ OwnerNextCheck(g) \/ OwnerClose(g) \/ WatchNudge(g)
         \/ SweepGoal(g) \/ Arrive(g) \/ LimitReached(g))
     \/ (\E r \in RowIds : Claim(r) \/ RecordSession(r) \/ StopByDeadline(r) \/ StopByCeiling(r)
         \/ ProcessDies(r) \/ ConfirmEnd(r) \/ Settle(r) \/ Tell(r) \/ SweepRow(r)
         \/ (\E v \in Verdicts : Report(r,v)))
     \/ (\E c \in Clients : PersistLast(c) \/ PersistMark(c) \/ PersistFail(c)
         \/ (\E r \in RowIds : PersistRead(c,r))))
Fair ==
 /\ (\A r \in RowIds : WF_vars(Claim(r)) /\ WF_vars(RecordSession(r)) /\ WF_vars(ConfirmEnd(r))
       /\ WF_vars(Settle(r)) /\ WF_vars(Tell(r)) /\ WF_vars(SweepRow(r)))
 /\ (\A g \in ActiveGoals : WF_vars(PauseByLimit(g)) /\ WF_vars(SweepGoal(g))
       /\ (IF OpportunityFair THEN SF_vars(Due(g)) /\ SF_vars(CreateNotice(g)) /\ SF_vars(NormalizeDay(g))
           ELSE WF_vars(Due(g)) /\ WF_vars(CreateNotice(g)) /\ WF_vars(NormalizeDay(g))))
 /\ (\A c \in Clients : WF_vars(PersistLast(c)) /\ WF_vars(PersistMark(c)))
 /\ (\A r \in RowIds : SF_vars(\E c \in Clients : PersistRead(c,r)))
 /\ WF_vars(QuietOn) /\ WF_vars(QuietOff) /\ WF_vars(DayPasses)
 /\ WF_vars(HelperRowAdd) /\ WF_vars(HelperRowDrop)
Spec == Init /\ [][Next]_vars /\ Fair
TypeOK ==
 /\ s.day \in {0,1} /\ s.normal \in 0..1 /\ s.quietHour \in BOOLEAN
 /\ s.ends \in 0..Cardinality(RowIds) /\ s.crashes \in 0..Faults /\ s.diskFails \in 0..Faults
 /\ (\A g \in Goals : s.g[g].status \in {"absent","active","proposed","paused","closed","removed"}
       /\ s.g[g].rev \in 1..3 /\ s.g[g].failures \in 0..FailuresToPause
       /\ s.g[g].check \in RowIds \cup {0} /\ s.g[g].checksToday \in 0..DayMax
       /\ s.g[g].checksDay \in {0,1} /\ s.g[g].report \in Verdicts \cup {None}
       /\ s.g[g].owes \in 0..3 /\ s.g[g].pause \in {None,"expired","ceiling","failures"}
       /\ s.g[g].due \in {"none","owner","helper","default"} /\ s.g[g].planBy \in 0..3
       /\ s.g[g].lastSaved \in RowIds \cup {0} /\ s.g[g].edits \in 0..MaxEdits
       /\ s.g[g].allocated \in 0..MaxAlloc
       /\ {s.g[g].arrived,s.g[g].ownerNext,s.g[g].expired,s.g[g].overCeiling,s.g[g].reportNext} \subseteq BOOLEAN)
 /\ (\A r \in RowIds : s.r[r].phase \in {"unused","pending","running","outcome","closed","removed"}
       /\ s.r[r].goal \in Goals \cup {0} /\ s.r[r].kind \in {"check","notice"}
       /\ s.r[r].rev \in 1..3 /\ s.r[r].stop \in {None,"deadline","ceiling","closed"}
       /\ s.r[r].outcome \in {None,"done","empty","failed","deadline","ceiling","stopped","interrupted"}
       /\ s.r[r].raw \in {None,"done","empty","failed","deadline","ceiling","stopped","interrupted"}
       /\ s.r[r].snapshot \in Content \cup {None,"paused"}
       /\ s.r[r].session \in {None,"live","ended"} /\ s.r[r].client \in {None,"live","dead"}
       /\ {s.r[r].told,s.r[r].partial,s.r[r].saved,s.r[r].hasText} \subseteq BOOLEAN
       /\ s.r[r].finishedAt \in 0..Cardinality(RowIds))
 /\ (\A c \in Clients : s.writers[c].stage \in {"idle","read","mark"}
       /\ s.writers[c].row \in RowIds \cup {0} /\ s.writers[c].goal \in Goals \cup {0})
OneLiveCheck == \A g \in ActiveGoals : Cardinality(Live(s,g))<=1 /\ \A r \in Live(s,g) : s.g[g].check=r
OneUntoldPerGoal == \A g \in ActiveGoals : Cardinality(Untold(s,g))<=1
NoFullTable == ~(Cardinality(Rows(s))=GoalRowsMax /\ s.normal=1)
RowsBounded == Cardinality(Rows(s))<=GoalRowsMax /\ Cardinality(Rows(s))+s.normal<=TotalRowsMax
ClosedFinal == \A g \in ActiveGoals : s.g[g].status="closed" => Untold(s,g)={}
ClaimOnlyActive == audit["ClaimOnlyActive"]
CancelChangesNothing == audit["CancelChangesNothing"]
OwnerNextKept == audit["OwnerNextKept"]
ContentReportTold == audit["ContentReportTold"]
SilentBranches == audit["SilentBranches"]
FailureCount == audit["FailureCount"]
NoStaleNotice == audit["NoStaleNotice"]
ClosedMeansClosed == audit["ClosedMeansClosed"] /\ ClosedFinal
NoSweepBeforeSaved == audit["NoSweepBeforeSaved"]
LastSavedMonotone == audit["LastSavedMonotone"]
GoalOutlivesRows == audit["GoalOutlivesRows"]
OnlyOwnerActs == audit["OnlyOwnerActs"]
DayCountBounded == audit["DayCountBounded"]
CheckReleased == \A g \in ActiveGoals : \A r \in RowIds : (s.g[g].check=r) ~> (s.g[g].check # r)
DueServed == \A g \in ActiveGoals : \A rev \in 1..(MaxEdits+1) :
     (s.g[g].status="active" /\ s.g[g].arrived /\ s.g[g].rev=rev) ~>
     (s.g[g].check # 0 \/ s.g[g].status \in {"paused","closed","removed"}
      \/ s.g[g].rev # rev \/ ~s.g[g].arrived)
PauseTold == \A g \in ActiveGoals : \A ticket \in 1..(MaxEdits+1) :
     (s.g[g].status="paused" /\ s.g[g].pauseTicket=ticket) ~>
     (s.g[g].pauseTold>=ticket \/ s.g[g].status # "paused" \/ s.g[g].pauseTicket # ticket)
ContentSaved == \A r \in RowIds :
     (HasContent(s,r) /\ s.r[r].told) ~>
     (IF s.r[r].goal=0 THEN FALSE ELSE Stamp(s,s.g[s.r[r].goal].lastSaved)>=s.r[r].finishedAt)
====
