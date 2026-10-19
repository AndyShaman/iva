---- MODULE DeferredRestart ----
EXTENDS Naturals, FiniteSets
CONSTANT Unsafe
VARIABLES running, pending, claimed, done, bridge, issued, queued, executed
vars == <<running, pending, claimed, done, bridge, issued, queued, executed>>
Init == /\ running = TRUE /\ pending = 0 /\ claimed = 0 /\ done = {}
        /\ bridge = TRUE /\ issued = 0 /\ queued = 0 /\ executed = <<0, 0>>
Request == /\ issued < 2 /\ issued' = issued + 1 /\ pending' = issued'
           /\ UNCHANGED <<running, claimed, done, bridge, queued, executed>>
Message == /\ queued < 2 /\ queued' = queued + 1
           /\ UNCHANGED <<running, pending, claimed, done, bridge, issued, executed>>
Finish == /\ running /\ running' = FALSE
          /\ UNCHANGED <<pending, claimed, done, bridge, issued, queued, executed>>
\* Bridge holds new Telegram input while a request or its result exists.
Start == /\ ~running /\ pending = 0 /\ claimed = 0 /\ queued > 0
         /\ running' = TRUE /\ queued' = queued - 1
         /\ UNCHANGED <<pending, claimed, done, bridge, issued, executed>>
Claim == /\ bridge /\ pending # 0 /\ claimed = 0 /\ (~running \/ Unsafe)
         /\ claimed' = pending /\ pending' = 0
         /\ UNCHANGED <<running, done, bridge, issued, queued, executed>>
\* Detached CLI survives the Bridge; its durable claim prevents a second launch.
Execute == /\ claimed # 0 /\ claimed \notin done
           /\ done' = done \cup {claimed}
           /\ executed' = [executed EXCEPT ![claimed] = @ + 1]
           /\ UNCHANGED <<running, pending, claimed, bridge, issued, queued>>
Report == /\ bridge /\ claimed \in done /\ claimed' = 0
          /\ UNCHANGED <<running, pending, done, bridge, issued, queued, executed>>
Crash == /\ bridge /\ bridge' = FALSE
         /\ UNCHANGED <<running, pending, claimed, done, issued, queued, executed>>
Boot == /\ ~bridge /\ bridge' = TRUE
        /\ UNCHANGED <<running, pending, claimed, done, issued, queued, executed>>
Next == Request \/ Message \/ Finish \/ Start \/ Claim \/ Execute \/ Report \/ Crash \/ Boot
Spec == Init /\ [][Next]_vars
OnlyIdle == claimed # 0 => ~running
AtMostOnce == \A i \in 1..2 : executed[i] <= 1
Durable == issued > 0 => pending = issued \/ claimed = issued \/ issued \in done
====
