# Morning 81: agent-chat#311 (CC-436), Shepherd marks its wakes as Shepherd's

PR: https://github.com/HJewkes/agent-chat/pull/311 (head 38d98b62, reviewed at 2bbd21a, +152/-37, CI green at the head, open since 10-02).

**Recommendation: re-review at 38d98b6, then merge.** Door type: one-way (it changes how agents tell your messages from automated ones, a security-posture question).

## What it does

Shepherd wakes an implementer (for example "CI failed, fix it") by sending a message through `human_send`, the same path your typed messages use. Today the event log and the receiving agent both read those wakes as you typing. The PR adds `shepherd` as a wake source beside `watchdog`:

- The broker records the source on the message event and on the delivered message (live push, inbox replay and seat-hold path).
- The receiving agent sees `wake_source="shepherd"` (or `watchdog`) in the channel tag.
- A sourced wake never carries `provenance="human-endorsed"`. A message with no source renders exactly as before.
- `agent-chat debug send <to> <text> --source shepherd` sends one by hand; an unknown source is refused at the CLI and dropped by the broker.

## Why it reaches you

Not by design. Shepherd's agent-chat policy is auto-merge on a reviewer MERGE, but when Shepherd judged the merge, GitHub was still recomputing mergeability, so `merge-tree-clean` read false and authority rule `MRG-AU` could only gate (accidental class: transient merge-state read; TP-1688 fixes it). The seat would still bring it to you as a one-way security-posture call. Also, the gate is at 2bbd21a, and the two broker commits on top (head 38d98b6) were never reviewed by Shepherd (TP-1689).

## Pros

- Agents stop mistaking Shepherd's automated wakes for your instructions, which today carry your authority.
- The event log can count Shepherd wakes apart from your messages (lane C and the stall forensics read these rows).
- It narrows authority: a source label only ever removes the "human typed this" reading. It never adds provenance.

## Cons

- The broker half (commits after 2bbd21a) has had no Shepherd review; approving the gate as it stands would approve a head nobody reviewed.
- Any local process that can run `agent-chat debug send` can label a message `shepherd`. That does not raise its trust, because a sourced message reads as lower trust than your own.
- It goes live only after a broker restart, so it waits for the next restart window.
- The branch is 3 days old: it needs a base update and a fresh CI run before it merges.

## Before and after

No rendered change.

## If you say yes

The seat has the new head 38d98b6 reviewed first, then updates the branch, re-checks CI, and merges at the new head. It then batches the change into the next broker restart.
