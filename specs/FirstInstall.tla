---- MODULE FirstInstall ----
\* Routing depends on layout and saved installation state, never on enabled units.
\* complete records .iva-installed; deferred records its autostart=false value.
EXTENDS Naturals
CONSTANT EnvMeansInstalled, ReleaseBeforeSetupStops, CloneOccupied, DeferredMeansInstalled
VARIABLES env, activated, complete, deferred, pending, layout, lock, setup, phase
vars == <<env, activated, complete, deferred, pending, layout, lock, setup, phase>>
Routes == {"update", "resume", "clone", "refuse"}
Incomplete == (pending /\ ~complete) \/ deferred
Init == /\ env \in BOOLEAN /\ activated \in BOOLEAN
        /\ complete \in BOOLEAN /\ deferred \in BOOLEAN /\ pending \in BOOLEAN
        /\ (deferred => complete /\ ~activated)
        /\ layout \in {"checkout", "versioned", "foreign", "empty"}
        /\ (layout = "empty" => ~env /\ ~complete /\ ~pending)
        /\ lock = FALSE /\ setup = FALSE /\ phase = "repeat"
Repeat == /\ phase \in {"repeat", "finished"}
          /\ phase' = CASE layout = "versioned" -> "update"
                     [] layout = "checkout" ->
                          IF ((pending /\ ~complete) \/ (deferred /\ ~DeferredMeansInstalled))
                             /\ ~(EnvMeansInstalled /\ env)
                          THEN "resume" ELSE "update"
                     [] layout = "empty" \/ CloneOccupied -> "clone"
                     [] OTHER -> "refuse"
          /\ UNCHANGED <<env, activated, complete, deferred, pending, layout, lock, setup>>
Acquire == /\ phase \in {"clone", "resume"} /\ ~lock
           /\ lock' = TRUE /\ setup' = TRUE /\ pending' = TRUE
           /\ layout' = "checkout" /\ activated' = FALSE /\ phase' = "setup"
           /\ UNCHANGED <<env, complete, deferred>>
Configure == /\ phase = "setup" /\ env' = TRUE /\ setup' = FALSE
             /\ phase' = "configured" /\ UNCHANGED <<activated, complete, deferred, pending, layout, lock>>
SkipSetup == /\ phase = "setup" /\ setup' = FALSE /\ phase' = "configured"
             /\ UNCHANGED <<env, activated, complete, deferred, pending, layout, lock>>
Activate == /\ phase = "configured" /\ activated' = TRUE
            /\ phase' = "activated" /\ UNCHANGED <<env, complete, deferred, pending, layout, lock, setup>>
Finish == /\ phase \in {"configured", "activated", "update"}
          /\ complete' = TRUE /\ pending' = FALSE /\ lock' = FALSE
          /\ deferred' = IF phase = "update" THEN deferred ELSE ~activated
          /\ phase' = "finished" /\ UNCHANGED <<env, activated, layout, setup>>
Disconnect == /\ phase \in {"setup", "configured", "activated"}
              /\ phase' = "disconnected" /\ UNCHANGED <<env, activated, complete, deferred, pending, layout, lock, setup>>
StopSetup == /\ phase = "disconnected" /\ setup' = FALSE /\ phase' = "stopped"
             /\ UNCHANGED <<env, activated, complete, deferred, pending, layout, lock>>
Release == /\ phase \in IF ReleaseBeforeSetupStops THEN {"disconnected", "stopped"} ELSE {"stopped"}
           /\ lock' = FALSE /\ phase' = "repeat"
           /\ UNCHANGED <<env, activated, complete, deferred, pending, layout, setup>>
Next == Repeat \/ Acquire \/ Configure \/ SkipSetup \/ Activate \/ Finish \/ Disconnect \/ StopSetup \/ Release
Spec == Init /\ [][Next]_vars
CompletedBeforeUpdate == phase = "update" /\ layout = "checkout" => ~Incomplete
SetupOwnsLock == setup => lock
SafeDestination == /\ (phase = "clone" => layout = "empty")
                   /\ (phase = "resume" => layout = "checkout" /\ Incomplete)
VersionedUsesUpdater == layout = "versioned" /\ phase \in Routes => phase = "update"
CompletedClearsMarker == phase = "finished" => complete /\ ~pending
\* Deliberately false invariant: a counterexample witnesses the occupied-directory outcome.
RefusedOccupied == ~(layout = "foreign" /\ phase = "refuse")
====
