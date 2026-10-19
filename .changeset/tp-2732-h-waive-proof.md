---
"@titan-design/factory": patch
---

A `NO_REPRO` `sh-sent-back` gate now offers the owner a `waive-proof` answer bound to the gate's head. It is never recommended, and no coordinator or decider answer can select it. The waiver is stored per run and head in `shepherd_proof_waiver`. The next round then reviews that head, and its MERGE withholds the merge-on-green grant, so it reaches only the owner's `approve-merge`. A new head is gated again. `FIX_FIRST` send-backs do not offer it.
