---
"@titan-design/factory": patch
---

A thaw no longer supersedes the approve-merge gate of a held run, an owner-asked hold included: the gate stays with the owner. Releasing the hold queues the run's repo for the thaw sweep, so the gate is superseded then, and a later head moves it as before with the hold kept.
