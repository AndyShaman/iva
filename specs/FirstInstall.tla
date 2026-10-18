---- MODULE FirstInstall ----
\* install.sh: only activated autostart completes the first installation.
\* A lost connection terminates setup before releasing the installer lock.
EXTENDS Naturals
CONSTANT EnvMeansInstalled, ReleaseBeforeSetupStops
VARIABLES env, activated, complete, lock, setup, phase
vars == <<env, activated, complete, lock, setup, phase>>
Init == /\ env = FALSE /\ activated = FALSE /\ complete = FALSE
        /\ lock = FALSE /\ setup = FALSE /\ phase = "start"
Acquire == /\ phase = "start" /\ ~lock
           /\ lock' = TRUE /\ setup' = TRUE /\ phase' = "setup"
           /\ UNCHANGED <<env, activated, complete>>
Configure == /\ phase = "setup" /\ env' = TRUE /\ setup' = FALSE
             /\ phase' = "configured" /\ UNCHANGED <<activated, complete, lock>>
Activate == /\ phase = "configured" /\ activated' = TRUE
            /\ phase' = "activated" /\ UNCHANGED <<env, complete, lock, setup>>
Finish == /\ phase = "activated" /\ complete' = TRUE /\ lock' = FALSE
          /\ phase' = "repeat" /\ UNCHANGED <<env, activated, setup>>
Disconnect == /\ phase \in {"setup", "configured", "activated"}
              /\ phase' = "disconnected" /\ UNCHANGED <<env, activated, complete, lock, setup>>
StopSetup == /\ phase = "disconnected" /\ setup' = FALSE /\ phase' = "stopped"
             /\ UNCHANGED <<env, activated, complete, lock>>
Release == /\ phase \in IF ReleaseBeforeSetupStops THEN {"disconnected", "stopped"} ELSE {"stopped"}
           /\ lock' = FALSE /\ phase' = "repeat"
           /\ UNCHANGED <<env, activated, complete, setup>>
Repeat == /\ phase = "repeat"
          /\ phase' = IF complete \/ (EnvMeansInstalled /\ env) THEN "update" ELSE "resume"
          /\ UNCHANGED <<env, activated, complete, lock, setup>>
Next == Acquire \/ Configure \/ Activate \/ Finish \/ Disconnect \/ StopSetup \/ Release \/ Repeat
Spec == Init /\ [][Next]_vars
CompletedBeforeUpdate == phase = "update" => complete /\ activated
SetupOwnsLock == setup => lock
====
