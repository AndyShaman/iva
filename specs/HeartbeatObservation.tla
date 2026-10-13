---- MODULE HeartbeatObservation ----
\* M4: parent scheduling delay after child exit says nothing about its heartbeat.
EXTENDS Naturals
CONSTANT AgeAfterExitGate
VARIABLES phase, observedTick, age, acquired
vars == <<phase, observedTick, age, acquired>>
Init == /\ phase = "held" /\ observedTick = FALSE /\ age = 0 /\ acquired = FALSE
Tick == /\ phase = "held" /\ phase' = "ticked" /\ observedTick' = TRUE /\ age' = 0 /\ UNCHANGED acquired
Kill == /\ phase = "ticked" /\ phase' = "dead" /\ UNCHANGED <<observedTick, age, acquired>>
ParentResumes == /\ phase = "dead" /\ phase' = "resumed" /\ age' \in {0, 2} /\ UNCHANGED <<observedTick, acquired>>
Take == /\ phase = "resumed" /\ phase' = "done" /\ acquired' = TRUE /\ UNCHANGED <<observedTick, age>>
Spec == Init /\ [][Tick \/ Kill \/ ParentResumes \/ Take]_vars
ObservedRecovery == phase = "done" => (observedTick /\ acquired /\ (~AgeAfterExitGate \/ age < 1))
====
