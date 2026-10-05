---
"@titan-design/factory": minor
---

Add a per-repo PR snapshot that `ci-wait` and `sh-observe` read instead of polling GitHub per run. It revalidates each repo's open-PR list once a minute with its ETag. It reads check runs only for a new head, or for a head whose counted checks are still running; the snapshot uses the same check set as the CI verdict. The snapshot may answer pending, red or behind, but `readCi` confirms a green through the port before returning it. Every write still re-reads its PR, and the snapshot is dropped after a write. The production routes wire it in; `LandDeps.snapshot` is optional, so a caller without one reads the port as before.
