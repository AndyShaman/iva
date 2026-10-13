--------------------------- MODULE HelperOutcome ---------------------------
EXTENDS Naturals, FiniteSets, TLC
CONSTANT Mutant
Helpers == {"a", "b"}
Keep == 1
VARIABLE s
vars == <<s>>
\* Session/turn belongs to consumer memory; durable row holds only deliveredAt.
Ready(h) == s.status[h] = "finished" /\ s.deliveredAt[h] = 0
Init == s = [status |-> [h \in Helpers |-> "pending"],
  outcome |-> [h \in Helpers |-> FALSE], finishes |-> [h \in Helpers |-> 0],
  finished |-> [h \in Helpers |-> 0],
  deliveredAt |-> [h \in Helpers |-> 0], retained |-> Helpers,
  session |-> 1, reads |-> {}, previousReads |-> {}, readCounts |-> [h \in Helpers |-> 0],
  replied |-> FALSE, nonempty |-> FALSE, now |-> 0,
  proof |-> [h \in Helpers |-> TRUE], readDirty |-> FALSE,
  lostUnread |-> FALSE, sweptEarly |-> FALSE, readAuthorized |-> TRUE,
  bridge |-> "online", events |-> {}, offlineFinished |-> {}]
Finish(h) ==
  /\ s.status[h] = "pending" \/ (Mutant = "finish-twice" /\ s.finishes[h] = 1)
  /\ s' = [s EXCEPT !.status[h] = "finished", !.outcome[h] = TRUE,
       !.finishes[h] = @ + 1, !.finished[h] = s.now,
       !.events = IF s.bridge = "online" THEN @ \cup {h} ELSE @,
       !.offlineFinished = IF s.bridge = "offline" THEN @ \cup {h} ELSE @]
Read(h,actor) ==
  /\ actor = "owner" \/ Mutant = "foreign-read"
  /\ h \in s.retained /\ s.outcome[h] /\ ~s.replied /\ h \notin s.reads
  /\ s.readCounts[h] < 2
  /\ s' = [s EXCEPT !.reads = @ \cup {h}, !.previousReads = @ \cup {h},
       !.readCounts[h] = @ + 1, !.readDirty = @ \/ Mutant = "read-write",
       !.readAuthorized = @ /\ actor = "owner"]
BridgeDown == /\ s.bridge = "online" /\ s' = [s EXCEPT !.bridge = "offline"]
BridgeUp == /\ s.bridge = "offline" /\ s' = [s EXCEPT !.bridge = "restarted", !.events = {}]
Reply(nonempty) ==
  /\ ~s.replied
  /\ s' = [s EXCEPT !.replied = TRUE, !.nonempty = nonempty]
Mark(h) ==
  /\ Ready(h)
  /\ (h \in s.reads) \/ Mutant = "without-read" \/
       (Mutant = "turn-only" /\ h \in s.previousReads /\ s.session = 2)
  /\ (s.replied /\ s.nonempty) \/ Mutant = "before-reply" \/
       (Mutant = "empty-reply" /\ s.replied)
  /\ s' = [s EXCEPT !.deliveredAt[h] = s.now + 1,
       !.proof[h] = s.replied /\ s.nonempty /\ h \in s.reads]
Restart ==
  /\ s.session = 1
  /\ s' = [s EXCEPT !.session = 2, !.reads = {}, !.replied = FALSE, !.nonempty = FALSE]
Close(h) ==
  /\ h \in s.retained /\ s.status[h] \in {"pending", "finished"}
  /\ s.deliveredAt[h] = 0
  /\ s' = [s EXCEPT !.status[h] = "closed", !.outcome[h] = TRUE,
       !.finished[h] = IF s.outcome[h] THEN @ ELSE s.now]
Clock == /\ s.now < 2 /\ s' = [s EXCEPT !.now = @ + 1]
Sweep(h) ==
  /\ h \in s.retained
  /\ (s.status[h] = "closed" /\ s.now >= s.finished[h] + Keep)
      \/ (s.deliveredAt[h] # 0 /\ s.now + 1 >= s.deliveredAt[h] + Keep)
      \/ (Mutant = "lose-unread" /\ Ready(h))
      \/ (Mutant = "early-close" /\ s.status[h] = "closed")
  /\ s' = [s EXCEPT !.retained = @ \ {h},
       !.lostUnread = @ \/ Ready(h),
       !.sweptEarly = @ \/ (s.status[h] = "closed" /\ s.now < s.finished[h] + Keep)]
Next == (\E h \in Helpers : Finish(h) \/ (\E actor \in {"owner","unknown","helper"} : Read(h,actor))
          \/ Mark(h) \/ Close(h) \/ Sweep(h))
        \/ (\E b \in BOOLEAN : Reply(b)) \/ Restart \/ Clock \/ BridgeDown \/ BridgeUp
Spec == Init /\ [][Next]_vars
TypeOK == /\ s.session \in {1,2} /\ s.now \in 0..2
          /\ s.retained \subseteq Helpers /\ s.reads \subseteq Helpers
          /\ \A h \in Helpers : s.status[h] \in {"pending","finished","closed"}
OutcomeOnce == \A h \in Helpers : s.finishes[h] <= 1
DeliveredAfterReply == \A h \in Helpers : s.deliveredAt[h] # 0 => s.proof[h]
UndeliveredKept == ~s.lostUnread
Visible == \A h \in Helpers : Ready(h) /\ h \in s.retained => Mutant # "hide-unread"
ClosedKept == ~s.sweptEarly
ReadPure == ~s.readDirty
ClosedFinal == \A h \in Helpers : s.status[h] = "closed" => s.outcome[h]
\* Reachability witnesses: multiple outcomes and repeated reading after restart are accepted.
NoTwoReads == Cardinality(s.reads) < 2
NoRepeatedRead == \A h \in Helpers : s.readCounts[h] < 2
AuthorizedReads == s.readAuthorized
OfflineEvent == s.offlineFinished \subseteq s.events
=============================================================================
