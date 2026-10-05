---
"@titan-design/factory": patch
"@titan-design/workflow": patch
---

Surface the errors Shepherd swallowed. `WorkflowRuntime.cancel` now throws a typed `WorkflowNotOwnedError` (same message) when it cannot claim the run. The gone-elsewhere sweep treats only that error as a lease held elsewhere; any other cancel failure goes to the new `onCancelFailed` callback, which serve logs, resync reports as `cancelErrors` and keeps held, and the pre-adoption recheck keeps unadopted. A `findPr` rejection in the Version Packages sweep is now a `{ repo, error }` note. A reviewer that never starts after failed roster reads names the last roster error in its reason. A thrown review-ruleset read or registration read still gates the merge, and the gate reason now names it (`unreadFacts` on the evidence).
