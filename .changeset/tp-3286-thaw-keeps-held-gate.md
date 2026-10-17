---
"@titan-design/factory": patch
---

A thaw no longer supersedes the approve-merge gate of a run with an owner-asked hold: the gate stays with the owner. Lifting or reclassing that hold queues the run's repo for the thaw sweep, so the gate is superseded then, and a later head moves it as before with the hold kept. A gate on a run with any other hold is still superseded on thaw, and the merge step waits on that hold, where its reviewer's verdict is read.
