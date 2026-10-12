### agent-chat#311 CC-436: Let Shepherd mark its human sends with source shepherd

https://github.com/HJewkes/agent-chat/pull/311 · head 38d98b6 (reviewed at 2bbd21a) · +152/-37 in 11 files · CI green at head · open 3 d

**Recommendation: re-review at 38d98b6, then merge.** Door type: one-way (hard to undo once agents rely on it).

#### What it does
Shepherd's automated wakes are labelled as Shepherd's, so agents stop reading them as the owner typing.

Shepherd wakes an implementer ("CI failed, fix it") through the same path your typed messages use, so today the event log and the receiving agent both read those wakes as you typing. After this PR, a Shepherd wake is labelled `wake_source="shepherd"`, beside the existing `watchdog`, and a labelled wake never carries your `human-endorsed` provenance. A message with no source renders exactly as before.
- The broker records the source on the message event and on every delivery path (live push, inbox replay, seat hold).
- The receiving agent sees the source in its channel tag.
- `agent-chat debug send <to> <text> --source shepherd` sends one by hand; an unknown source is refused by the CLI and dropped by the broker.

#### Why it reaches you
Not by design: GitHub was still recomputing mergeability (mergeable_state unknown), so `merge-tree-clean` read false; TP-1688 settles this transient merge-state read (accidental). Rule `MRG-AU`. The gate is at 2bbd21a, but the PR head is 38d98b6. The last review is at 2bbd21a; no reviewer has read the commits after it. The reviewer adds: It changes how every agent tells the owner's messages from automated ones.

#### Pros
- Agents stop mistaking Shepherd's automated wakes for your instructions, which today carry your authority.
- The event log can count Shepherd wakes apart from your messages.
- It only narrows authority: a source label removes the "human typed this" reading and never adds provenance.

#### Cons
- The commits after 2bbd21a have had no review; approving the gate as it stands would approve unreviewed code.
- Any local process that can run `agent-chat debug send` can label a message `shepherd`. That lowers its trust rather than raising it.
- It goes live only after a broker restart.

#### Before and after
No rendered change.

#### If you say yes / If you say no
Yes: Shepherd supersedes the gate, a reviewer reviews 38d98b6, and if MERGE holds it merges without asking you again. No: the seat closes the PR and CC-436 returns to the queue with your note.
