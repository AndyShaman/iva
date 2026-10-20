---- MODULE NightProgress ----
\* ADR-0016: A accumulates answers in the day cache, before any Card/summary write.
\* A received answer can be lost before atomic save. Saved answers survive every
\* interruption; only a complete sequence is published through NightWriter.
EXTENDS Naturals, Sequences
CONSTANTS Parts, MaxAttempts, ResumeProgress, BoundAttempts
VARIABLES phase, cursor, saved, received, failures, result, crashed
vars == <<phase, cursor, saved, received, failures, result, crashed>>

Init == /\ phase = "ask" /\ cursor = 0 /\ saved = <<>>
        /\ received = 0 /\ failures = 0 /\ result = <<>> /\ crashed = FALSE

Receive ==
  /\ phase = "ask" /\ cursor < Parts
  /\ received' = cursor + 1 /\ phase' = "received"
  /\ UNCHANGED <<cursor, saved, failures, result, crashed>>
Save ==
  /\ phase = "received"
  /\ saved' = Append(saved, received) /\ cursor' = cursor + 1
  /\ phase' = IF cursor' = Parts THEN "publish" ELSE "ask"
  /\ UNCHANGED <<received, failures, result, crashed>>
\* Observed transient failures/ceiling cuts consume an Attempt, also after A.
\* Process death/deadline before an observed failure consumes no Attempt.
Interrupt ==
  /\ phase \in {"ask", "received", "publish"}
  /\ failures < MaxAttempts + 1
  /\ failures' = failures + 1
  /\ phase' = IF BoundAttempts /\ failures' >= MaxAttempts
                 THEN "paused" ELSE "interrupted"
  /\ UNCHANGED <<cursor, saved, received, result, crashed>>
Crash ==
  /\ ~crashed /\ phase \in {"ask", "received", "publish"}
  /\ phase' = "interrupted" /\ crashed' = TRUE
  /\ UNCHANGED <<cursor, saved, received, failures, result>>
Resume ==
  /\ phase = "interrupted"
  /\ cursor' = IF ResumeProgress THEN Len(saved) ELSE 0
  /\ phase' = IF cursor' = Parts THEN "publish" ELSE "ask"
  /\ received' = 0
  /\ UNCHANGED <<saved, failures, result, crashed>>
Publish ==
  /\ phase = "publish" /\ result' = saved /\ phase' = "done"
  /\ UNCHANGED <<cursor, saved, received, failures, crashed>>
Settled == phase \in {"paused", "done"} /\ UNCHANGED vars
Next == Receive \/ Save \/ Interrupt \/ Crash \/ Resume \/ Publish \/ Settled
Spec == Init /\ [][Next]_vars /\ WF_vars(Receive) /\ WF_vars(Save)
        /\ WF_vars(Resume) /\ WF_vars(Publish)

TypeOK == /\ phase \in {"ask", "received", "publish", "interrupted", "paused", "done"}
          /\ cursor \in 0..Parts /\ received \in 0..Parts
          /\ saved \in Seq(1..Parts) /\ result \in Seq(1..Parts)
          /\ failures \in 0..(MaxAttempts + 1) /\ crashed \in BOOLEAN
\* Each saved answer contributes once, in the same order as an uninterrupted day.
PortionsAppliedOnce == saved = [i \in 1..Len(saved) |-> i]
SameResult == phase = "done" => result = [i \in 1..Parts |-> i]
AttemptsBounded == failures <= MaxAttempts
EventuallySettled == <>(phase \in {"done", "paused"})
====
