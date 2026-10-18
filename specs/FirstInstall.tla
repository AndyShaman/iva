---- MODULE FirstInstall ----
\* Routing depends on layout and the first-install marker, never on enabled units.
\* Every successful exit clears the marker, including deferred setup/autostart.
EXTENDS Naturals
CONSTANT EnvMeansInstalled, ReleaseBeforeSetupStops, CloneOccupied
VARIABLES env, activated, complete, pending, layout, lock, setup, phase
vars == <<env, activated, complete, pending, layout, lock, setup, phase>>
Routes == {"update", "resume", "clone", "refuse"}
Init == /\ env \in BOOLEAN /\ activated \in BOOLEAN
        /\ complete \in BOOLEAN /\ pending \in BOOLEAN
        /\ layout \in {"checkout", "versioned", "foreign", "empty"}
        /\ (layout = "empty" => ~env /\ ~complete /\ ~pending)
        /\ lock = FALSE /\ setup = FALSE /\ phase = "repeat"
Repeat == /\ phase \in {"repeat", "finished"}
          /\ phase' = CASE layout = "versioned" -> "update"
                     [] layout = "checkout" ->
                          IF pending /\ ~complete /\ ~(EnvMeansInstalled /\ env)
                          THEN "resume" ELSE "update"
                     [] layout = "empty" \/ CloneOccupied -> "clone"
                     [] OTHER -> "refuse"
          /\ UNCHANGED <<env, activated, complete, pending, layout, lock, setup>>
Acquire == /\ phase \in {"clone", "resume"} /\ ~lock
           /\ lock' = TRUE /\ setup' = TRUE /\ pending' = TRUE
           /\ layout' = "checkout" /\ phase' = "setup"
           /\ UNCHANGED <<env, activated, complete>>
Configure == /\ phase = "setup" /\ env' = TRUE /\ setup' = FALSE
             /\ phase' = "configured" /\ UNCHANGED <<activated, complete, pending, layout, lock>>
SkipSetup == /\ phase = "setup" /\ setup' = FALSE /\ phase' = "configured"
             /\ UNCHANGED <<env, activated, complete, pending, layout, lock>>
Activate == /\ phase = "configured" /\ activated' = TRUE
            /\ phase' = "activated" /\ UNCHANGED <<env, complete, pending, layout, lock, setup>>
Finish == /\ phase \in {"configured", "activated", "update"}
          /\ complete' = TRUE /\ pending' = FALSE /\ lock' = FALSE
          /\ phase' = "finished" /\ UNCHANGED <<env, activated, layout, setup>>
Disconnect == /\ phase \in {"setup", "configured", "activated"}
              /\ phase' = "disconnected" /\ UNCHANGED <<env, activated, complete, pending, layout, lock, setup>>
StopSetup == /\ phase = "disconnected" /\ setup' = FALSE /\ phase' = "stopped"
             /\ UNCHANGED <<env, activated, complete, pending, layout, lock>>
Release == /\ phase \in IF ReleaseBeforeSetupStops THEN {"disconnected", "stopped"} ELSE {"stopped"}
           /\ lock' = FALSE /\ phase' = "repeat"
           /\ UNCHANGED <<env, activated, complete, pending, layout, setup>>
Next == Repeat \/ Acquire \/ Configure \/ SkipSetup \/ Activate \/ Finish \/ Disconnect \/ StopSetup \/ Release
Spec == Init /\ [][Next]_vars
CompletedBeforeUpdate == phase = "update" /\ layout = "checkout" => ~(pending /\ ~complete)
SetupOwnsLock == setup => lock
SafeDestination == /\ (phase = "clone" => layout = "empty")
                   /\ (phase = "resume" => layout = "checkout" /\ pending /\ ~complete)
VersionedUsesUpdater == layout = "versioned" /\ phase \in Routes => phase = "update"
CompletedClearsMarker == phase = "finished" => complete /\ ~pending
\* Deliberately false invariant: a counterexample witnesses the occupied-directory outcome.
RefusedOccupied == ~(layout = "foreign" /\ phase = "refuse")
====
