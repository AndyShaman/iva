---- MODULE PackageContract ----
\* A wt.sh checkout and the shared node_modules load distinct function objects.
\* Resolver/validator gates observe outputs; object identity belongs to the loader.
EXTENDS Naturals
CONSTANTS IdentityGate, ChangedBehavior
VARIABLES phase, input, accepted
vars == <<phase, input, accepted>>
Inputs == {"empty", "padded", "invalid", "versioned"}
Expected == [x \in Inputs |-> CASE x = "empty" -> "default"
                           [] x = "padded" -> "canonical"
                           [] x = "invalid" -> "fallback"
                           [] OTHER -> "installation-home"]
Init == /\ phase = "load" /\ input = "empty" /\ accepted = TRUE
Load == /\ phase = "load" /\ phase' = "check" /\ input' \in Inputs /\ UNCHANGED accepted
Check == /\ phase = "check" /\ phase' = "done"
         /\ accepted' = IF IdentityGate THEN FALSE
                        ELSE Expected[input] = (IF ChangedBehavior THEN "wrong" ELSE Expected[input])
         /\ UNCHANGED input
Spec == Init /\ [][Load \/ Check]_vars
BehaviorAgrees == phase = "done" => accepted
====
