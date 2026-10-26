------------------------ MODULE PluginUnitScope ------------------------
EXTENDS Naturals, FiniteSets
CONSTANT BadGlobalCleanup
Actors == {"A", "B"}
Units == {"LA", "SA", "LB", "SB", "Unknown", "Collision", "Link", "LoadedForeign", "OverwrittenLegacy"}
Legacy(i) == IF i = "A" THEN "LA" ELSE "LB"
Scoped(i) == IF i = "A" THEN "SA" ELSE "SB"
Reps(i) == {Legacy(i), Scoped(i)}
Key(u) == CASE u \in {"LA","SA"} -> "plugin-a"
          [] u \in {"LB","SB"} -> "plugin-b" [] OTHER -> u
Data(i) == IF i = "A" THEN "/data/a" ELSE "/data/b"
Scope(i) == IF i = "A" THEN "hash-a" ELSE "hash-b"
Port(i) == IF i = "A" THEN 11 ELSE 22
None == "none"

(* Ground truth belongs only to invariant evaluation, never to the classifier.
   LoadedForeign/OverwrittenLegacy already have an A file over a B process. *)
TrueFile == [u \in Units |-> IF u \in {"LA", "SA", "LoadedForeign", "OverwrittenLegacy"} THEN "A" ELSE "B"]
TrueProcess == [u \in Units |-> IF u \in {"LA", "SA"} THEN "A" ELSE "B"]

(* Independently observable fixed fields of bounded fixture bodies and queries.
   Port stands for the plugins.json port. FileData stands for validated service
   WorkingDirectory/PLUGIN_DATA or MCP data/token. LoadedData stands for the
   narrow manager WorkingDirectory or loaded MCP data/token/port proof. *)
FileData == [u \in Units |-> CASE u \in {"LA", "SA", "Link", "LoadedForeign", "OverwrittenLegacy"} -> "/data/a"
                            [] u = "Unknown" -> "unreadable" [] OTHER -> "/data/b"]
LoadedData == [u \in Units |-> CASE u \in {"LA", "SA"} -> "/data/a"
                              [] u = "Unknown" -> "unreadable" [] OTHER -> "/data/b"]
FilePort == [u \in Units |-> IF FileData[u] = "/data/a" THEN 11 ELSE 22]
NameScope == [u \in Units |-> CASE u \in {"SA", "Collision", "Link", "LoadedForeign"} -> "hash-a"
                             [] u = "SB" -> "hash-b" [] OTHER -> "legacy"]
MarkerScope == [u \in Units |-> IF FileData[u] = "/data/a" THEN "hash-a" ELSE "hash-b"]
Regular == [u \in Units |-> u # "Link"]
PayloadValid == [u \in Units |-> u # "Unknown"]
InitialPresent == Units \ {"SA", "SB"}
InitialActive == InitialPresent
InitialMarked == {"Collision", "Link", "LoadedForeign"}
BadFixtures == {"Unknown", "Collision", "Link", "LoadedForeign", "OverwrittenLegacy"}

VARIABLES present, active, marked, wanted, armed, effect, codeVersion
vars == <<present, active, marked, wanted, armed, effect, codeVersion>>
EmptyEffect == [actor |-> None, files |-> {}, controls |-> {}, startedData |-> None]
Init == /\ present = InitialPresent /\ active = InitialActive
        /\ marked = InitialMarked /\ wanted = [i \in Actors |-> TRUE]
        /\ armed = [i \in Actors |-> TRUE] /\ effect = EmptyEffect
        /\ codeVersion = 0

(* Only evidence is read here. A removed state entry cannot authorize an
   unmarked legacy; a marked stale unit still decodes its own key/data. *)
DiskProof(i,u) == /\ u \in present /\ Regular[u] /\ PayloadValid[u]
                  /\ FileData[u] = Data(i) /\ FilePort[u] = Port(i)
                  /\ IF u \in marked
                        THEN /\ MarkerScope[u] = Scope(i)
                             /\ NameScope[u] \in {"legacy", Scope(i)}
                        ELSE /\ NameScope[u] = "legacy" /\ wanted[i]
LoadedProof(i,u) == LoadedData[u] = Data(i)
Owned(i,u) == /\ DiskProof(i,u)
              /\ (NameScope[u] # "legacy" \/ LoadedProof(i,u))
Actual(i,k) == LET choices == {u \in Units: Key(u) = k /\ Owned(i,u)}
             IN IF Cardinality(choices) = 1 THEN CHOOSE u \in choices: TRUE ELSE None
Audit(i,files,controls,data) ==
    effect' = [actor |-> i, files |-> files, controls |-> controls, startedData |-> data]

(* Only marker bytes change; there is no service-control effect. *)
Adopt(i,u) == /\ Actual(i,Key(u)) = u /\ NameScope[u] = "legacy"
              /\ u \notin marked /\ u \in active /\ wanted[i]
              /\ marked' = marked \cup {u} /\ Audit(i,{u},{},None)
              /\ UNCHANGED <<present,active,wanted,armed,codeVersion>>
RequestRemove(i) == /\ wanted[i]
                    /\ wanted' = [wanted EXCEPT ![i] = FALSE]
                    /\ armed' = [armed EXCEPT ![i] = FALSE]
                    /\ effect' = EmptyEffect
                    /\ UNCHANGED <<present,active,marked,codeVersion>>
Stop(i,u) == /\ ~wanted[i] /\ Owned(i,u) /\ LoadedProof(i,u) /\ u \in active
             /\ active' = active \ {u} /\ Audit(i,{}, {u},None)
             /\ UNCHANGED <<present,marked,wanted,armed,codeVersion>>
Delete(i,u) == /\ ~wanted[i] /\ Owned(i,u) /\ LoadedProof(i,u) /\ u \notin active
               /\ present' = present \ {u} /\ marked' = marked \ {u}
               /\ Audit(i,{u},{},None)
               /\ UNCHANGED <<active,wanted,armed,codeVersion>>
ReEnable(i) == /\ ~wanted[i]
               /\ wanted' = [wanted EXCEPT ![i] = TRUE]
               /\ effect' = EmptyEffect
               /\ UNCHANGED <<present,active,marked,armed,codeVersion>>
Create(i) == /\ wanted[i] /\ Reps(i) \cap present = {}
              /\ Reps(i) \cap active = {}
              /\ present' = present \cup {Scoped(i)}
              /\ marked' = marked \cup {Scoped(i)}
              /\ Audit(i,{Scoped(i)},{},None)
              /\ UNCHANGED <<active,wanted,armed,codeVersion>>
Start(i) == /\ wanted[i] /\ Actual(i,Key(Scoped(i))) = Scoped(i)
             /\ LoadedProof(i,Scoped(i)) /\ Scoped(i) \notin active
             /\ Legacy(i) \notin active
             /\ active' = active \cup {Scoped(i)}
             /\ armed' = [armed EXCEPT ![i] = TRUE]
             /\ Audit(i,{}, {Scoped(i)},LoadedData[Scoped(i)])
             /\ UNCHANGED <<present,marked,wanted,codeVersion>>
Restart(i,u) == /\ wanted[i] /\ Actual(i,Key(u)) = u /\ u \in active /\ LoadedProof(i,u)
                /\ Audit(i,{}, {u},LoadedData[u])
                /\ UNCHANGED <<present,active,marked,wanted,armed,codeVersion>>
Observe(i) == /\ effect' = EmptyEffect
              /\ UNCHANGED <<present,active,marked,wanted,armed,codeVersion>>
Flip == /\ codeVersion' = 1 - codeVersion /\ effect' = EmptyEffect
        /\ UNCHANGED <<present,active,marked,wanted,armed>>
(* Crash between the separate durable steps is a stutter. Failed stop is also
   a stutter: the old file and listener still block Create. *)
Crash == UNCHANGED vars

(* Mutant is the previous global-name stale removal. Same real side effects
   and same audit as a normal deletion; no hidden owner check or error flag. *)
GlobalCleanup(i,u) == /\ BadGlobalCleanup /\ ~wanted[i]
                      /\ u \in {"LA","LB"} /\ u \in present
                      /\ present' = present \ {u}
                      /\ active' = active \ {u} /\ marked' = marked \ {u}
                      /\ Audit(i,{u}, IF u \in active THEN {u} ELSE {},None)
                      /\ UNCHANGED <<wanted,armed,codeVersion>>
Next == (\E i \in Actors:
           (\E u \in Units: Adopt(i,u) \/ Stop(i,u) \/ Delete(i,u)
                             \/ Restart(i,u) \/ GlobalCleanup(i,u))
           \/ RequestRemove(i) \/ ReEnable(i) \/ Create(i) \/ Start(i) \/ Observe(i))
        \/ Flip \/ Crash
TypeOK == /\ present \subseteq Units /\ active \subseteq Units /\ marked \subseteq Units
          /\ wanted \in [Actors -> BOOLEAN] /\ armed \in [Actors -> BOOLEAN]
          /\ codeVersion \in {0,1}
CrossInstallSafety == /\ \A u \in effect.files: TrueFile[u] = effect.actor
                      /\ \A u \in effect.controls: TrueProcess[u] = effect.actor
UnknownPreserved == /\ BadFixtures \subseteq present /\ BadFixtures \subseteq active
                    /\ marked \cap BadFixtures = InitialMarked
NoWrongRoots == effect.startedData = None \/ effect.startedData = Data(effect.actor)
OneListener == \A i \in Actors: Cardinality(Reps(i) \cap active) <= 1
Continuity == \A i \in Actors: armed[i] => Actual(i,Key(Scoped(i))) \in (Reps(i) \cap active)
Spec == Init /\ [][Next]_vars
=============================================================================
