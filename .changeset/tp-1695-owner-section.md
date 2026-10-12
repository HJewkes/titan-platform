---
"@titan-design/factory": minor
---

`buildOwnerSection` builds the owner PR section (link, what it does, why it reaches you, pros, cons, before and after, next steps) plus a round@2 section and a pick-one question with a recommendation, from the PR facts, the pending gate, the run's owner-gate reason and the reviewer's verdict and owner brief. `whyAsked` maps every gate rule (seat owner-gate, every merge-guard row, authority MRG-AU unmet conditions, route escalations, release rows and the factory default) to one plain sentence labelled deliberate, accidental or unclassified. The gate head and the review head are read apart: a missing review, a review behind the PR head and a gate behind the PR head are each stated, and none recommends merge. A merge-tree-clean failure is called transient only when the evidence recorded mergeable_state unknown.
