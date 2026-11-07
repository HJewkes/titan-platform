---
"@titan-design/factory": minor
---

Shepherd now carries `@titan-design/*` releases into consumer repos. An hourly consumer bump sweep (`CONSUMER_BUMP_SWEEP_MS`, overridable through `consumerBumpSweepMs` in `PackageSweepOptions`) opens at most one bump PR per seat-book consumer behind npm latest, regenerates its lockfile and registers it with Shepherd. `titan-factory release bump-consumers` runs one sweep by hand; `--dry-run` prints one line per PR it would open and writes nothing. Either form exits UNAVAILABLE when any repo notes an error.
