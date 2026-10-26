---
"@titan-design/factory": patch
---

A Shepherd run no longer fails when a `ci-wait` window times out on a wait only GitHub can end (TP-4180). If the last read before the timeout saw `mergeable_state unknown`, an open repo's unconfirmed second read, or an HTTP 5xx, land waits again in a fresh `ci-wait` step, up to `CI_WAIT_ATTEMPTS` (3) windows in a row. Once the checks go green the run goes on to review with no re-register. A red check still ends the wait at once. When every attempt times out, the run fails with `ci-wait timed out after <ms> ms on each of 3 attempts: <last read>`. `shepherd timeline` shows each timed-out window as a `ci-timeout` event that names its attempt.
