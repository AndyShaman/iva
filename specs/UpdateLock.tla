---- MODULE UpdateLock ----
\* An abandoned directory has the recorded owner "dead". Each process makes
\* one attempt. mkdir, read, rename, comparison, owner publication and release
\* are separate filesystem steps. A renamed live directory stays owned even
\* while its original path is empty; a third mkdir or a legacy rm is residual.
EXTENDS Naturals, FiniteSets
CONSTANT Participants, LegacyCleaner, RenameCheck
Actors == 1..Participants
Empty == 0
Dead == 2 * Participants + 1
Pending(p) == Participants + p
VARIABLES owner, phase, parked, holders
vars == <<owner, phase, parked, holders>>
Init == /\ owner = Dead /\ holders = {}
        /\ phase = [p \in Actors |-> "start"]
        /\ parked = [p \in Actors |-> Empty]
Legacy(p) == LegacyCleaner /\ p = Participants
Inspect(p) == /\ phase[p] = "start"
              /\ phase' = [phase EXCEPT ![p] =
                    IF owner = Empty THEN "claim"
                    ELSE IF owner = Dead THEN "observed" ELSE "done"]
              /\ UNCHANGED <<owner, parked, holders>>
Take(p) == /\ phase[p] = "observed" /\ ~Legacy(p) /\ RenameCheck
           /\ parked' = [parked EXCEPT ![p] = owner]
           /\ phase' = [phase EXCEPT ![p] = IF owner = Empty THEN "done" ELSE "compare"]
           /\ owner' = Empty /\ UNCHANGED holders
Compare(p) == /\ phase[p] = "compare"
              /\ phase' = [phase EXCEPT ![p] = IF parked[p] = Dead THEN "discard" ELSE "restore"]
              /\ UNCHANGED <<owner, parked, holders>>
Discard(p) == /\ phase[p] = "discard"
              /\ parked' = [parked EXCEPT ![p] = Empty]
              /\ phase' = [phase EXCEPT ![p] = "claim"]
              /\ UNCHANGED <<owner, holders>>
Restore(p) == /\ phase[p] = "restore"
              /\ owner' = IF owner = Empty THEN parked[p] ELSE owner
              /\ parked' = IF owner = Empty THEN [parked EXCEPT ![p] = Empty] ELSE parked
              /\ phase' = [phase EXCEPT ![p] = "done"]
              /\ UNCHANGED holders
DeleteByPath(p) == /\ phase[p] = "observed" /\ (Legacy(p) \/ ~RenameCheck)
                   /\ owner' = Empty /\ phase' = [phase EXCEPT ![p] = "claim"]
                   /\ UNCHANGED <<parked, holders>>
Claim(p) == /\ phase[p] = "claim"
            /\ owner' = IF owner = Empty THEN Pending(p) ELSE owner
            /\ phase' = [phase EXCEPT ![p] = IF owner = Empty THEN "created" ELSE "done"]
            /\ UNCHANGED <<parked, holders>>
\* The atomic JSON writer can recreate a parent moved between mkdir and write.
Publish(p) == /\ phase[p] = "created"
              /\ owner' = p /\ holders' = holders \cup {p}
              /\ phase' = [phase EXCEPT ![p] = "held"] /\ UNCHANGED parked
Release(p) == /\ phase[p] = "held"
              /\ holders' = holders \ {p}
              /\ owner' = IF owner = p THEN Empty ELSE owner
              /\ phase' = [phase EXCEPT ![p] = "done"] /\ UNCHANGED parked
Next == \E p \in Actors: Inspect(p) \/ Take(p) \/ Compare(p) \/ Discard(p)
        \/ Restore(p) \/ DeleteByPath(p) \/ Claim(p) \/ Publish(p) \/ Release(p)
Spec == Init /\ [][Next]_vars
MutualExclusion == Cardinality(holders) <= 1
====
