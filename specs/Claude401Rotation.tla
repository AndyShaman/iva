------------------------- MODULE Claude401Rotation -------------------------
EXTENDS Naturals
CONSTANTS ExtraRetry, AfterEffect
VARIABLES phase, calls, visible, currentTool, oldTool, proven, version,
          valid, expired, resources, auth, alerts, unsafe, cancelCalls
vars == <<phase, calls, visible, currentTool, oldTool, proven, version,
          valid, expired, resources, auth, alerts, unsafe, cancelCalls>>

Init == /\ phase = "ready" /\ calls = 0 /\ visible = FALSE
        /\ currentTool \in BOOLEAN /\ oldTool \in BOOLEAN /\ proven \in BOOLEAN
        /\ version = 0 /\ valid = TRUE /\ expired = FALSE
        /\ resources = FALSE /\ auth = FALSE /\ alerts = 0
        /\ unsafe = FALSE /\ cancelCalls = 0
Safe == ~visible /\ ~currentTool /\ proven
CanRepeat == calls < (IF ExtraRetry THEN 3 ELSE 2) /\ proven
             /\ ((~visible /\ ~currentTool) \/ AfterEffect)
Begin == /\ phase = "ready" /\ phase' = "call" /\ calls' = 1
         /\ resources' = TRUE
         /\ UNCHANGED <<visible, currentTool, oldTool, proven, version, valid,
                         expired, auth, alerts, unsafe, cancelCalls>>
Output == /\ phase = "call" /\ ~visible /\ visible' = TRUE
          /\ UNCHANGED <<phase, calls, currentTool, oldTool, proven, version,
                          valid, expired, resources, auth, alerts, unsafe, cancelCalls>>
Fail401 == /\ phase = "call" /\ phase' = "close401" /\ auth' = TRUE
           /\ UNCHANGED <<calls, visible, currentTool, oldTool, proven, version,
                           valid, expired, resources, alerts, unsafe, cancelCalls>>
Close == /\ phase = "close401" /\ resources' = FALSE
         /\ phase' = IF CanRepeat THEN "wait" ELSE "failure"
         /\ UNCHANGED <<calls, visible, currentTool, oldTool, proven, version,
                         valid, expired, auth, alerts, unsafe, cancelCalls>>
Change == /\ phase \in {"call", "close401", "wait"} /\ version = 0
          /\ version' = 1 /\ valid' = TRUE
          /\ UNCHANGED <<phase, calls, visible, currentTool, oldTool, proven,
                          expired, resources, auth, alerts, unsafe, cancelCalls>>
Invalid == /\ phase \in {"call", "close401", "wait"} /\ valid
           /\ valid' = FALSE
           /\ UNCHANGED <<phase, calls, visible, currentTool, oldTool, proven,
                           version, expired, resources, auth, alerts, unsafe, cancelCalls>>
Valid == /\ phase \in {"call", "close401", "wait"} /\ ~valid /\ valid' = TRUE
         /\ UNCHANGED <<phase, calls, visible, currentTool, oldTool, proven,
                         version, expired, resources, auth, alerts, unsafe, cancelCalls>>
Expire == /\ phase = "wait" /\ ~expired /\ expired' = TRUE
          /\ UNCHANGED <<phase, calls, visible, currentTool, oldTool, proven,
                          version, valid, resources, auth, alerts, unsafe, cancelCalls>>
Repeat == /\ phase = "wait" /\ ((valid /\ version = 1) \/ expired)
          /\ phase' = "call" /\ calls' = calls + 1 /\ resources' = TRUE
          /\ unsafe' = (unsafe \/ ~Safe) /\ auth' = FALSE
          /\ UNCHANGED <<visible, currentTool, oldTool, proven, version, valid,
                          expired, alerts, cancelCalls>>
Succeed == /\ phase = "call" /\ phase' = "success"
           /\ resources' = FALSE /\ auth' = FALSE
           /\ UNCHANGED <<calls, visible, currentTool, oldTool, proven, version,
                           valid, expired, alerts, unsafe, cancelCalls>>
OtherFailure == /\ phase = "call" /\ phase' = "failure"
                /\ resources' = FALSE /\ auth' = FALSE
                /\ UNCHANGED <<calls, visible, currentTool, oldTool, proven, version,
                                valid, expired, alerts, unsafe, cancelCalls>>
Cancel == /\ phase \in {"ready", "call", "close401", "wait"}
          /\ phase' = "cancelled" /\ resources' = FALSE /\ cancelCalls' = calls
          /\ UNCHANGED <<calls, visible, currentTool, oldTool, proven, version,
                          valid, expired, auth, alerts, unsafe>>
Notify == /\ phase = "failure" /\ auth /\ alerts = 0 /\ alerts' = 1
          /\ UNCHANGED <<phase, calls, visible, currentTool, oldTool, proven,
                          version, valid, expired, resources, auth, unsafe, cancelCalls>>
Next == Begin \/ Output \/ Fail401 \/ Close \/ Change \/ Invalid \/ Valid \/ Expire
        \/ Repeat \/ Succeed \/ OtherFailure \/ Cancel \/ Notify
Spec == Init /\ [][Next]_vars
CallsAtMostTwo == calls <= 2
RepeatIsSafe == ~unsafe
CancelStopsCalls == phase = "cancelled" => calls = cancelCalls
OneFinalAlert == alerts <= 1 /\ (alerts > 0 => phase = "failure" /\ auth)
SuccessIsSilent == phase = "success" => alerts = 0
WaitingIsClean == phase = "wait" => ~resources
=============================================================================
