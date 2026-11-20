---
"@titan-design/factory": minor
---

Add Shepherd's auto-by-rec sweep (TP-6772). It looks at pending approve-merge gates, either authority MRG-AU or a visual-path gate, that recommend merge and that the owner has left past `shepherd.autoByRec.afterHours` (default 24). For each one it re-reads the head, the reviewer's MERGE, the required checks, the hold classes, the D-class and the changed paths, then runs `byRecDecision` and MRG-AU-RB. In `shadow` mode (the default) it only writes a `titan/auto-by-rec@1` would-resolve row. In `live` mode it cancels the gate with `auto-by-rec: ...`; land reads that cancel as a merge of that head alone, and nothing carries the merge to a later head. `titan-factory shepherd by-rec --json [--since]` lists the rows. `shepherd stats --gates` reports these merges in an `auto-by-rec` resolver bucket.
