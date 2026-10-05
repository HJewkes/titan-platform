---
"@titan-design/factory": minor
---

Add a per-repo PR snapshot that `ci-wait` and `sh-observe` read instead of polling GitHub per run. It revalidates each repo's open-PR list once a minute with its ETag, and reads check runs only for a new head or one whose required checks are still pending. Every write still re-reads its PR through the port, and the snapshot is dropped after a write. The production routes wire it in; `LandDeps.snapshot` is optional, so a caller without one reads the port as before.
