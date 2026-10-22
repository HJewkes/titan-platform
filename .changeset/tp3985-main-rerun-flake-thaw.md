---
"@titan-design/factory": minor
---

On a red main, Shepherd now reruns the failed jobs at the red sha once per freeze episode (`sh-main-rerun`, decision 525). If every red job comes back green in Shepherd's own rerun, the repo thaws at the red sha. The rerun runs alongside `sh-spawn-fixer`, so a deterministic red never waits on it, and after a thaw the fixer keeps working the flake task. The fixer brief tells a flaky-test fix that changes only tests to register `--kind test-only` with no mutation spec. A rerun someone else started never counts. Before the thaw, the episode's fix task becomes a flake task: both runs' ids and URLs, the job names, the failing tests and an error excerpt are appended, the task is tagged `flake` and reopened if it was done, and its `done_when` asks for a root-cause fix, not a retry, a timeout bump or a quarantine. If the task cannot be updated, the repo stays frozen. A failing test that already thawed main this way within 24 hours stays frozen as before. The fix-task port gains an optional `markFlake`.

`fileFixTask` no longer replaces an episode's fixer or fix task with a standing fixer from an earlier red. A fixer the episode gained while the standing fixer was looked up keeps its freeze exemption.
