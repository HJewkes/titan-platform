---
"@titan-design/factory": minor
---

Autoresearch gains its snapshot and sync effects (C-256 S5c). `cutSnapshot` tags a kept ratchet sha at `refs/tags/ar/<target>/<runId>/m<k>` and pushes a `<ratchetPrefix>-snap/<runId>/m<k>` branch one log commit past it, in one atomic push with create-only leases, so a second cut at the same `m<k>` is refused and a refused branch leaves no tag. `openSnapshotPr` and `registerSnapshot` open and register the snapshot PR through the existing GitHub port and `shepherd.register`. `syncRatchet` merges main back into the ratchet after a snapshot PR merges, returning a conflict or a frozen change for the gate instead of pushing. merge-lint declares the push as `autoresearch-snapshot`. Nothing is wired yet.
