---- MODULE EmptyResponse ----
\* Bounded empty-response recovery, before the H3 repair. Each attempt is a
\* runOneModelCall. Exhaustion settles a plain task; conversations still park.
\* FailTask models the old isError/turn.failed branch. Unbounded models an
\* accidental fourth reissue. Schema and step-limit contracts remain failures.
EXTENDS Naturals
CONSTANTS Mode, Guarded, FailTask, Unbounded
VARIABLES calls, outcome
vars == <<calls, outcome>>
Init == /\ calls = 0 /\ outcome = "running"
Call == /\ outcome = "running" /\ calls < 4
        /\ calls' = calls + 1 /\ UNCHANGED outcome
Exhaust == /\ outcome = "running" /\ calls = 4
           /\ IF Unbounded THEN /\ calls' = 5 /\ UNCHANGED outcome
              ELSE /\ UNCHANGED calls
                   /\ outcome' = IF Mode = "conversation" THEN "parked"
                                  ELSE IF Guarded \/ FailTask THEN "failed"
                                  ELSE "completed-with-notice"
Next == Call \/ Exhaust
Spec == Init /\ [][Next]_vars
Bounded == calls <= 4
TaskNotice == (Mode = "task" /\ ~Guarded /\ calls = 4 /\ outcome # "running")
              => outcome = "completed-with-notice"
ProtectedContract == Guarded /\ Mode = "task" /\ outcome # "running" => outcome = "failed"
ConversationParks == Mode = "conversation" /\ outcome # "running" => outcome = "parked"
====
