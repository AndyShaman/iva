---- MODULE NightProgress ----
\* ADR-0016: A accumulates answers in the day cache, before any Card/summary write.
\* A received answer can be lost before atomic save. Saved answers survive every
\* interruption; only a complete sequence is published through NightWriter.
EXTENDS Naturals, Sequences
CONSTANTS Parts, MaxAttempts, ResumeProgress, BoundAttempts, CountTransient
VARIABLES phase, cursor, saved, received, failures, result, crashed, savedThrough, askedSaved, realFailures, interruptions
vars == <<phase, cursor, saved, received, failures, result, crashed, savedThrough, askedSaved, realFailures, interruptions>>

Init == /\ phase = "ask" /\ cursor = 0 /\ saved = <<>>
        /\ received = 0 /\ failures = 0 /\ result = <<>> /\ crashed = FALSE
        /\ savedThrough = 0 /\ askedSaved = FALSE /\ realFailures = 0 /\ interruptions = 0

Receive ==
  /\ phase = "ask" /\ cursor < Parts
  /\ received' = cursor + 1 /\ phase' = "received"
  /\ askedSaved' = (askedSaved \/ cursor + 1 <= savedThrough)
  /\ UNCHANGED <<cursor, saved, failures, result, crashed, savedThrough, realFailures, interruptions>>
Save ==
  /\ phase = "received"
  /\ saved' = Append(saved, received) /\ cursor' = cursor + 1
  /\ savedThrough' = IF cursor' > savedThrough THEN cursor' ELSE savedThrough
  /\ phase' = IF cursor' = Parts THEN "publish" ELSE "ask"
  /\ UNCHANGED <<received, failures, result, crashed, askedSaved, realFailures, interruptions>>
\* Only actual day failures consume an Attempt.
\* Process death/deadline before an observed failure consumes no Attempt.
Interrupt ==
  /\ phase \in {"ask", "received", "publish"}
  /\ failures < MaxAttempts + 1
  /\ failures' = failures + 1 /\ realFailures' = realFailures + 1
  /\ phase' = IF BoundAttempts /\ failures' >= MaxAttempts
                 THEN "paused" ELSE "interrupted"
  /\ UNCHANGED <<cursor, saved, received, result, crashed, savedThrough, askedSaved, interruptions>>
Crash ==
  /\ ~crashed /\ phase \in {"ask", "received", "publish"}
  /\ phase' = "interrupted" /\ crashed' = TRUE
  /\ UNCHANGED <<cursor, saved, received, failures, result, savedThrough, askedSaved, realFailures, interruptions>>
\* Ceiling cuts, like temporary outages/deadlines, preserve attempts and saved A.
\* CountTransient is the mutant that counts these interruptions as day failures.
Transient ==
  /\ phase \in {"ask", "received", "publish"} /\ interruptions < MaxAttempts + 1
  /\ phase' = "interrupted" /\ interruptions' = interruptions + 1
  /\ failures' = IF CountTransient THEN failures + 1 ELSE failures
  /\ UNCHANGED <<cursor, saved, received, result, crashed, savedThrough, askedSaved, realFailures>>
Resume ==
  /\ phase = "interrupted"
  /\ cursor' = IF ResumeProgress THEN Len(saved) ELSE 0
  /\ phase' = IF cursor' = Parts THEN "publish" ELSE "ask"
  /\ received' = 0
  /\ saved' = IF ResumeProgress THEN saved ELSE <<>>
  /\ UNCHANGED <<failures, result, crashed, savedThrough, askedSaved, realFailures, interruptions>>
Publish ==
  /\ phase = "publish" /\ result' = saved /\ phase' = "done"
  /\ UNCHANGED <<cursor, saved, received, failures, crashed, savedThrough, askedSaved, realFailures, interruptions>>
Settled == phase \in {"paused", "done"} /\ UNCHANGED vars
Next == Receive \/ Save \/ Interrupt \/ Transient \/ Crash \/ Resume \/ Publish \/ Settled
Spec == Init /\ [][Next]_vars /\ WF_vars(Receive) /\ WF_vars(Save)
        /\ WF_vars(Resume) /\ WF_vars(Publish)

TypeOK == /\ phase \in {"ask", "received", "publish", "interrupted", "paused", "done"}
          /\ cursor \in 0..Parts /\ received \in 0..Parts
          /\ saved \in Seq(1..Parts) /\ result \in Seq(1..Parts)
          /\ failures \in 0..(MaxAttempts + 1) /\ crashed \in BOOLEAN
          /\ savedThrough \in 0..Parts /\ askedSaved \in BOOLEAN
          /\ realFailures \in 0..(MaxAttempts + 1) /\ interruptions \in 0..(MaxAttempts + 1)
\* Each saved answer contributes once, in the same order as an uninterrupted day.
PortionsAppliedOnce == saved = [i \in 1..Len(saved) |-> i]
SameResult == phase = "done" => result = [i \in 1..Parts |-> i]
AttemptsBounded == failures <= MaxAttempts
SavedNeverAsked == ~askedSaved
TransientPreservesAttempts == failures = realFailures
EventuallySettled == <>(phase \in {"done", "paused"})
====
