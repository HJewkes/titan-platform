---
"@titan-design/factory": patch
---

Shepherd keeps one main-red fixer per freeze episode. `setFixer` no longer overwrites a fixer the episode already recorded, so the first spawn wins. `sh-spawn-fixer` names the fixer from the episode's first red sha, not the run's own merge sha, so concurrent runs agree on one name. It reads the episode again just before the spawn, and retires a fixer it spawned when another fixer was recorded meanwhile. A run whose PR is registered on the episode's fix task but is still frozen (no fix PR marked, and the implementer is not the recorded fixer) tells its seat once per head after `THAW_STALL_ROUNDS` thaw rounds, naming the `titan-factory shepherd fix-pr <repo> <pr> --episode <n>` command.
