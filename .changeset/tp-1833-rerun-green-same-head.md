---
"@titan-design/factory": patch
---

After a red ci-wait, Shepherd's wait for the fixer's new head also re-reads the required checks at the unchanged head on each poll. When a rerun of the failed jobs turns them all green, the run leaves `sh-await-new-head` and collects merge facts at that head, with no new commit. Waits after review and conflict wakes are unchanged.
