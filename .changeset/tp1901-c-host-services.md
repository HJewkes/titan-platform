---
"@titan-design/titan": minor
---

`titan host services list [--json]` and `titan host services install --dry-run` print every host-owned scheduled job for this platform (backup, health sampler, usage refresh, memory sampler) with its source: rendered here, delegated to another installer, owned by chezmoi, or deferred to a named host-job task. On linux the dry run prints the backup service and timer with their target paths, any legacy `restic-nightly` unit found, and the `systemctl --user` commands; darwin renders nothing. `install` without `--dry-run` exits 2 and writes nothing.
