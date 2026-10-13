----------------------------- MODULE HelperRun -----------------------------
EXTENDS Naturals, FiniteSets, TLC
CONSTANTS Case, Mutant, Helpers
VARIABLE s
vars == <<s>>
Empty == [status |-> "absent", run |-> FALSE, owner |-> 0, fired |-> 0,
  known |-> FALSE, clientId |-> FALSE, recordFailed |-> FALSE, client |-> FALSE, active |-> FALSE, cancel |-> FALSE,
  stop |-> "none", outcome |-> "none", partial |-> 0, saved |-> 0,
  steps |-> 0, previous |-> 0, work |-> 0, workProof |-> TRUE,
  ceilingPending |-> FALSE, ceilingLost |-> FALSE, finishedByTick |-> FALSE,
  limited |-> FALSE, finishes |-> 0, endedProof |-> TRUE, stopProof |-> TRUE, may |-> "",
  authorized |-> TRUE, mayPresent |-> TRUE, asked |-> FALSE, retained |-> TRUE,
  finishedAt |-> 0, closedEarly |-> FALSE, closeChanged |-> FALSE,
  effects |-> 0, restartEffect |-> FALSE, lateEffect |-> FALSE, tailEffect |-> FALSE]
Init == s = [rows |-> [h \in Helpers |-> Empty], now |-> 0, owner |-> 1,
             restarted |-> FALSE, missingRead |-> FALSE, normalEnd |-> FALSE]
Open == {h \in Helpers : s.rows[h].status = "pending"}
Running == {h \in Helpers : s.rows[h].run}
Add(h,actor,hasMay) ==
  /\ s.rows[h].status = "absent"
  /\ Cardinality(Open) < 3
  /\ actor = "owner" \/ Mutant = "helper-start"
  /\ hasMay \/ Mutant = "missing-may"
  /\ s' = [s EXCEPT !.rows[h] = [Empty EXCEPT !.status = "pending",
        !.may = IF Mutant = "may-copy" THEN "changed" ELSE "opaque",
        !.authorized = actor = "owner", !.mayPresent = hasMay]]
Claim(h) ==
  /\ s.rows[h].status = "pending" /\ ~s.rows[h].run /\ s.rows[h].outcome = "none"
  /\ Cardinality(Running) < 1 \/ Mutant = "capacity"
  /\ s' = [s EXCEPT !.rows[h].run = TRUE, !.rows[h].owner = s.owner,
                   !.rows[h].fired = 1, !.rows[h].client = TRUE]
Create(h) ==
  /\ s.rows[h].run /\ s.rows[h].client /\ ~s.rows[h].active /\ ~s.rows[h].known
  /\ s.rows[h].stop = "none" /\ s.now = 0
  /\ s' = [s EXCEPT !.rows[h].active = TRUE, !.rows[h].clientId = TRUE]
RecordSession(h) ==
  /\ s.rows[h].run /\ s.rows[h].client /\ s.rows[h].active /\ ~s.rows[h].known
  /\ s' = [s EXCEPT !.rows[h].known = TRUE]
RecordFailure(h) ==
  /\ s.rows[h].run /\ s.rows[h].client /\ s.rows[h].clientId
  /\ ~s.rows[h].known /\ ~s.rows[h].recordFailed
  /\ s' = [s EXCEPT !.rows[h].recordFailed = TRUE, !.rows[h].cancel = TRUE]
Message(h) ==
  /\ s.rows[h].run /\ s.rows[h].client /\ s.rows[h].active
  /\ s.rows[h].stop = "none" /\ ~s.rows[h].recordFailed /\ s.rows[h].partial < 2
  /\ s' = [s EXCEPT !.rows[h].partial = @ + 1]
Usage(h,input,output) ==
  /\ s.rows[h].run /\ s.rows[h].client /\ s.rows[h].active
  /\ s.rows[h].stop = "none"
  /\ s.rows[h].steps < (IF Mutant = "step-limit" THEN 3 ELSE 2)
  /\ LET delta == (IF input > s.rows[h].previous THEN input - s.rows[h].previous ELSE 0) + output
         work == s.rows[h].work + (IF Mutant = "work-output" THEN delta - output ELSE delta)
     IN s' = [s EXCEPT !.rows[h].steps = @ + 1, !.rows[h].previous = input,
       !.rows[h].work = work, !.rows[h].limited = s.rows[h].steps + 1 >= 2,
       !.rows[h].workProof = @ /\ (Mutant # "work-output" \/ output = 0),
       !.rows[h].ceilingPending = @ \/ (work > 3 /\ Mutant # "work-stop")]
\* Usage reports first; the asynchronous store stop can lose to natural completion.
CeilingStop(h) ==
  /\ s.rows[h].ceilingPending
  /\ s' = [s EXCEPT !.rows[h].ceilingPending = FALSE,
       !.rows[h].stop = IF s.rows[h].run /\ s.rows[h].stop = "none"
         THEN "ceiling" ELSE @]
Stop(h,why) ==
  /\ s.rows[h].run /\ s.rows[h].stop = "none"
  /\ s' = [s EXCEPT !.rows[h].stop = why,
       !.rows[h].stopProof = TRUE]
OverwriteStop(h) ==
  /\ Mutant = "stop-twice" /\ s.rows[h].stop # "none"
  /\ s' = [s EXCEPT !.rows[h].stop = "deadline", !.rows[h].stopProof = FALSE]
Question(h) ==
  /\ s.rows[h].run /\ s.rows[h].active /\ ~s.rows[h].asked
  /\ s' = [s EXCEPT !.rows[h].asked = TRUE, !.rows[h].cancel = TRUE]
Cancel(h) ==
  /\ s.rows[h].run /\ (s.rows[h].known \/ (s.rows[h].client /\ s.rows[h].clientId)) /\ ~s.rows[h].cancel
  /\ s.rows[h].stop # "none" \/ s.rows[h].asked \/ ~s.rows[h].client
      \/ s.rows[h].owner # s.owner \/ s.now >= 3
  /\ s' = [s EXCEPT !.rows[h].cancel = TRUE]
End(h) ==
  /\ s.rows[h].active
  /\ s.rows[h].cancel \/ s.now >= 3 \/ s.rows[h].partial = 2 \/ s.rows[h].limited
  /\ s' = [s EXCEPT !.rows[h].active = FALSE]
ClientExit(h) ==
  /\ s.rows[h].client
  /\ s' = [s EXCEPT !.rows[h].client = FALSE]
RunnerTimeout(h) ==
  /\ s.now = 3 /\ s.rows[h].client
  /\ s' = [s EXCEPT !.rows[h].client = FALSE]
Eligible(h,tick) ==
  IF tick THEN s.rows[h].owner # s.owner \/ ~s.rows[h].client \/ s.now >= 3
  ELSE s.rows[h].client /\ (s.rows[h].known \/ ~s.rows[h].active)
CanFinish(h,tick) ==
  /\ s.rows[h].run /\ Eligible(h,tick)
  /\ (~s.rows[h].active) \/ (tick /\ ~s.rows[h].known /\ ~s.rows[h].client)
     \/ Mutant = "early-free"
Result(h,tick) ==
  IF s.rows[h].stop = "closed" THEN "stopped"
  ELSE IF s.rows[h].stop # "none" THEN s.rows[h].stop
  ELSE IF s.rows[h].recordFailed THEN "failed"
  ELSE IF s.rows[h].asked THEN IF Mutant = "question-done" THEN "done" ELSE "failed"
  ELSE IF tick THEN IF s.now >= 2 THEN "deadline" ELSE "interrupted"
  ELSE IF s.rows[h].limited THEN IF s.rows[h].partial > 0 THEN "ceiling" ELSE "failed"
  ELSE IF s.rows[h].partial > 0 THEN "done" ELSE "empty"
Finish(h,tick) ==
  /\ CanFinish(h,tick) \/ (Mutant = "finalize-twice" /\ s.rows[h].finishes = 1)
  /\ s' = [s EXCEPT !.rows[h].run = FALSE,
       !.rows[h].status = IF s.rows[h].stop = "closed" THEN "closed" ELSE "finished",
       !.rows[h].outcome = Result(h,tick), !.rows[h].finishes = @ + 1,
       !.rows[h].saved = IF tick \/ Mutant = "partial" THEN 0 ELSE s.rows[h].partial,
       !.rows[h].finishedByTick = tick,
       !.rows[h].ceilingLost = ~tick /\ Result(h,tick) = "done" /\ s.rows[h].work > 3,
       !.rows[h].finishedAt = s.now,
       !.rows[h].endedProof = ~s.rows[h].active \/ (~s.rows[h].known /\ ~s.rows[h].client)]
StaleFinish(h) ==
  /\ Mutant = "stale-cas" /\ s.rows[h].run
  /\ s' = [s EXCEPT !.rows[h].run = FALSE, !.rows[h].outcome = "done",
       !.rows[h].status = "finished", !.rows[h].endedProof = FALSE]
StartFailed(h) ==
  /\ s.rows[h].run /\ s.rows[h].client /\ ~s.rows[h].active /\ ~s.rows[h].known /\ s.rows[h].partial = 0
  /\ s' = [s EXCEPT !.rows[h].run = FALSE, !.rows[h].client = FALSE,
       !.rows[h].status = "finished", !.rows[h].outcome = "failed",
       !.rows[h].finishes = @ + 1, !.rows[h].finishedAt = s.now]
Close(h) ==
  /\ s.rows[h].status \in {"pending", "finished"}
  /\ IF s.rows[h].run THEN Stop(h,"closed")
     ELSE s' = [s EXCEPT !.rows[h].status = "closed",
       !.rows[h].outcome = IF s.rows[h].outcome = "none" THEN "stopped"
         ELSE IF Mutant = "close-outcome" THEN "stopped" ELSE @,
       !.rows[h].closeChanged = s.rows[h].outcome # "none" /\ Mutant = "close-outcome",
       !.rows[h].finishedAt = IF s.rows[h].outcome = "none" THEN s.now ELSE @]
ReadClosed(h) ==
  /\ s.rows[h].status = "closed" /\ s.rows[h].retained /\ ~s.missingRead
  /\ s' = [s EXCEPT !.missingRead = Mutant = "hide-closed"]
Sweep(h) ==
  /\ s.rows[h].status = "closed" /\ s.rows[h].retained
  /\ s.now >= s.rows[h].finishedAt + 1 \/ Mutant = "early-sweep"
  /\ s' = [s EXCEPT !.rows[h].retained = FALSE,
       !.rows[h].closedEarly = s.now < s.rows[h].finishedAt + 1]
Restart ==
  /\ s.owner = 1
  /\ s' = [s EXCEPT !.owner = 2, !.restarted = TRUE,
       !.rows = [h \in Helpers |-> [s.rows[h] EXCEPT !.client = FALSE]]]
Effect(h) ==
  /\ s.rows[h].active /\ s.rows[h].effects < 2
  /\ s' = [s EXCEPT !.rows[h].effects = @ + 1,
       !.rows[h].lateEffect = @ \/ s.rows[h].stop # "none",
       !.rows[h].restartEffect = @ \/ (s.restarted /\ s.rows[h].owner # s.owner),
       !.rows[h].tailEffect = @ \/ (~s.rows[h].run /\ ~s.rows[h].known)]
NormalWaiting(h) ==
  /\ ~s.normalEnd /\ s.rows[h].run /\ s.rows[h].active
  /\ s.rows[h].known /\ ~s.rows[h].asked /\ s.rows[h].stop = "none"
  /\ s.rows[h].partial > 0
  /\ s' = [s EXCEPT !.rows[h].active = FALSE, !.normalEnd = TRUE]
Clock == /\ s.now < 3 /\ s' = [s EXCEPT !.now = @ + 1]
Lifecycle(h) == Claim(h) \/ Create(h) \/ RecordSession(h) \/ RecordFailure(h) \/ Message(h)
  \/ (\E why \in {"closed","ceiling","deadline"}: Stop(h,why)) \/ OverwriteStop(h)
  \/ (\E input \in 0..(IF Case = "effects" THEN 2 ELSE 3), output \in 0..1 : Usage(h,input,output))
  \/ CeilingStop(h)
  \/ Question(h) \/ Cancel(h) \/ End(h) \/ ClientExit(h) \/ RunnerTimeout(h)
  \/ Finish(h,TRUE) \/ Finish(h,FALSE) \/ StaleFinish(h) \/ StartFailed(h)
  \/ Close(h) \/ ReadClosed(h) \/ Sweep(h)
Next == (\E h \in Helpers :
  (\E actor \in {"owner","helper"}, hasMay \in BOOLEAN : Add(h,actor,hasMay))
  \/ (Case # "auth" /\ (IF Case = "capacity" THEN Claim(h) ELSE Lifecycle(h))) \/ (Case = "effects" /\ Effect(h)))
  \/ (Case # "auth" /\ (Clock \/ Restart)) \/ (\E h \in Helpers : NormalWaiting(h))
Spec == Init /\ [][Next]_vars
FairSpec == Spec /\ WF_vars(Clock) /\ \A h \in Helpers :
  WF_vars(Cancel(h)) /\ WF_vars(End(h)) /\ WF_vars(RunnerTimeout(h)) /\ WF_vars(Finish(h,TRUE))
  /\ WF_vars(CeilingStop(h))
TypeOK == /\ s.now \in 0..3 /\ s.owner \in {1,2}
  /\ \A h \in Helpers : s.rows[h].status \in {"absent","pending","finished","closed"}
Authorized == \A h \in Helpers : s.rows[h].authorized
MayRequired == \A h \in Helpers : s.rows[h].mayPresent
MayUnchanged == \A h \in Helpers : s.rows[h].status # "absent" => s.rows[h].may = "opaque"
OneRun == Cardinality(Running) <= 1
WithinLimits == \A h \in Helpers : s.rows[h].steps <= 2
WorkMeasured == \A h \in Helpers : s.rows[h].workProof
WorkStops == \A h \in Helpers : s.rows[h].run /\ s.rows[h].active
  /\ s.rows[h].stop = "none" /\ s.rows[h].work > 3 => s.rows[h].ceilingPending
OutcomeOnce == \A h \in Helpers : s.rows[h].finishes <= 1
StopOnce == \A h \in Helpers : s.rows[h].stopProof
ClosedFinal == \A h \in Helpers : s.rows[h].status = "closed" => s.rows[h].outcome # "none"
SlotFreedAfterEnd == \A h \in Helpers : s.rows[h].endedProof
QuestionFailed == \A h \in Helpers : s.rows[h].asked /\ s.rows[h].outcome # "none" /\ s.rows[h].stop = "none" => s.rows[h].outcome # "done"
PartialKept == \A h \in Helpers : s.rows[h].finishes > 0 /\ ~s.rows[h].finishedByTick
  => s.rows[h].saved = s.rows[h].partial
KeepClosed == \A h \in Helpers : ~s.rows[h].closedEarly
ClosedReadable == ~s.missingRead
CloseKeepsOutcome == \A h \in Helpers : ~s.rows[h].closeChanged
NoSilentEnd == \A h \in Helpers : s.rows[h].run ~> (s.rows[h].outcome # "none")
\* Witnesses of accepted consequences, not guarantees or extra mechanisms.
NoRestartEffect == \A h \in Helpers : ~s.rows[h].restartEffect
NoLateEffect == \A h \in Helpers : ~s.rows[h].lateEffect
NoDuplicateEffect == \A h \in Helpers : s.rows[h].effects < 2
NoTailEffect == \A h \in Helpers : ~s.rows[h].tailEffect
NoNormalWaiting == ~s.normalEnd
NoCeilingRace == \A h \in Helpers : ~s.rows[h].ceilingLost
TickRetainsText == \A h \in Helpers : s.rows[h].finishedByTick => s.rows[h].saved = s.rows[h].partial
=============================================================================
