---
"@titan-design/worktree": patch
---

Preserve the dispatcher's existing CC-1095 git transport guard during worktree consumption. Internal git calls and setup child environments now narrow caller protocol lists to file:git:http:https:ssh, or use that list when unset. Export the unchanged pin helpers for thin consumer adapters; retain and document the separate inherited CC-1336 config-precedence limitation.
