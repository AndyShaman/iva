--------------------------- MODULE ScheduleTool ---------------------------
EXTENDS Naturals, FiniteSets
CONSTANT Mutant
VARIABLES generation, pending, due, fired, id, text
vars == <<generation, pending, due, fired, id, text>>
Init == /\ generation = 0 /\ pending = TRUE /\ due = TRUE
        /\ fired = [g \in 0..2 |-> 0] /\ id = "r-1" /\ text = "instruction"
\* move/run_now take the same table lock as Tick. Each explicit request arms
\* one firing, preserving identity and payload. A missed minute stays due.
Edit(now) == /\ generation < 2 /\ generation' = generation + 1
             /\ pending' = TRUE /\ due' = now
             /\ UNCHANGED <<fired, id, text>>
Minute == /\ ~due /\ due' = TRUE
          /\ UNCHANGED <<generation, pending, fired, id, text>>
Tick == /\ due /\ (pending \/ Mutant) /\ fired[generation] < 2
        /\ fired' = [fired EXCEPT ![generation] = @ + 1]
        /\ pending' = FALSE
        /\ UNCHANGED <<generation, due, id, text>>
Next == Edit(TRUE) \/ Edit(FALSE) \/ Minute \/ Tick
Spec == Init /\ [][Next]_vars
OncePerRequest == \A g \in 0..2 : fired[g] <= 1
IdentityKept == id = "r-1" /\ text = "instruction"
=============================================================================
