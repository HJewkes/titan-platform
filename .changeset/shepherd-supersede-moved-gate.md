---
"@titan-design/factory": patch
---

Shepherd supersedes a seat-policy approve-merge gate whose pull request head moved. The serve sweep that ends merged-elsewhere runs now also checks each pending shepherd-pr approve-merge gate, at any iteration, and acts on it only when the run's last recorded merge decision gated that same head under the `shepherd-seat` table. When the open PR's head differs from that head, the sweep cancels the gate. The run records the cancel, leaves the land round and reviews the new head, so the owner is asked again only about a reviewed head. Conflict gates and escalation gates share the approve-merge step id but stay with the owner when the head moves, as do `sh-sent-back` and every other gate. Any cancel of approve-merge other than the sweep's still fails the run.
