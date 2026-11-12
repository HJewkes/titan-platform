---
"@titan-design/factory": patch
---

The Version Packages sweep now restarts a release run that stopped not-mergeable or on a conflict once the changesets action pushes a new head, so a stopped release no longer waits for a hand re-register. It restarts once per head, and an owner abandon stays stopped.
