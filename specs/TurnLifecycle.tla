---- MODULE TurnLifecycle ----
EXTENDS Naturals

\* R1: existing client outcome, silence watchdog and stop guard. Model before repair.
\* Settle -> scripts/lib/reminder-turn.ts:settleTurn; Expire/CancelDone/Reset ->
\* readTurnStream/stopParkedTurn/resetSession. Capture/Replace/Observe ->
\* telegram-stop.ts and poller/control.ts. Session stays the same across two turns.
\* Time is three abstract stages: inactivity, bounded cancel, bounded reset.
\* External cancel can answer, reject or hang; the bound has the same transition.
\* Excludes durable server execution, helper completion and effects of tools.
CONSTANT Fault
VARIABLES failure, cancelled, limited, settled, outcome,
          watchdog, cancelRequested, reset, started,
          current, captured, observed, waiting
vars == <<failure, cancelled, limited, settled, outcome,
          watchdog, cancelRequested, reset, started,
          current, captured, observed, waiting>>
Init == /\ failure \in BOOLEAN /\ cancelled \in BOOLEAN /\ limited \in BOOLEAN
        /\ settled = FALSE /\ outcome = "unset"
        /\ watchdog = "reading" /\ cancelRequested = FALSE /\ reset = FALSE
        /\ started = FALSE /\ current = "old" /\ captured = "unset"
        /\ observed = FALSE /\ waiting = FALSE
Settle == /\ ~settled /\ settled' = TRUE
          /\ outcome' = IF cancelled THEN "cancelled"
                         ELSE IF limited THEN "limit"
                         ELSE IF failure /\ Fault # "failure" THEN "failed"
                         ELSE "text"
          /\ UNCHANGED <<failure, cancelled, limited, watchdog, cancelRequested,
                         reset, started, current, captured, observed, waiting>>
Start == /\ ~started /\ started' = TRUE
         /\ UNCHANGED <<failure, cancelled, limited, settled, outcome,
                        watchdog, cancelRequested, reset, current, captured,
                        observed, waiting>>
Expire == /\ watchdog = "reading" /\ watchdog' = "cancel"
          /\ cancelRequested' = (Fault # "silence" \/ started)
          /\ UNCHANGED <<failure, cancelled, limited, settled, outcome,
                         reset, started, current, captured, observed, waiting>>
CancelDone == /\ watchdog = "cancel" /\ cancelRequested
              /\ watchdog' = "reset" /\ reset' = TRUE
              /\ UNCHANGED <<failure, cancelled, limited, settled, outcome,
                             cancelRequested, started, current, captured,
                             observed, waiting>>
Reset == /\ watchdog = "reset" /\ watchdog' = "returned"
         /\ UNCHANGED <<failure, cancelled, limited, settled, outcome,
                        cancelRequested, reset, started, current, captured,
                        observed, waiting>>
Capture == /\ captured = "unset" /\ captured' = current
           /\ UNCHANGED <<failure, cancelled, limited, settled, outcome,
                          watchdog, cancelRequested, reset, started, current,
                          observed, waiting>>
Replace == /\ captured = "old" /\ current = "old" /\ ~observed /\ current' = "next"
           /\ UNCHANGED <<failure, cancelled, limited, settled, outcome,
                          watchdog, cancelRequested, reset, started, captured,
                          observed, waiting>>
Observe == /\ captured # "unset" /\ ~observed /\ observed' = TRUE
           /\ waiting' = (IF Fault = "identity" THEN TRUE ELSE current = captured)
           /\ UNCHANGED <<failure, cancelled, limited, settled, outcome,
                          watchdog, cancelRequested, reset, started, current, captured>>
Next == Settle \/ Start \/ Expire \/ CancelDone \/ Reset \/ Capture \/ Replace \/ Observe
Spec == Init /\ [][Next]_vars
OwnerFirst == settled /\ cancelled => outcome = "cancelled"
LimitFirst == settled /\ ~cancelled /\ limited => outcome = "limit"
FailurePreserved == settled /\ failure /\ ~cancelled /\ ~limited => outcome = "failed"
CancelBeforeStart == watchdog = "cancel" => cancelRequested
ResetReached == watchdog = "returned" => reset
OldTurnStopped == observed /\ current # captured => ~waiting
====
