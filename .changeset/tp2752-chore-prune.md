---
"@titan-design/factory": patch
---

Serve now removes a post-merge chore's marker, spec and result files once the `post-merge` step has a recorded result, on the step's `step_complete` event and on host bind for sets a crash left behind; files of a step with no recorded result stay for `reconcilePostMerge`. `FactoryRoutes` gains an `onEvent` hook, `composeRoutes` merges two bundles' `bindHost` and `onEvent` (a throwing hook is logged and never stops the other), and `withAutoresearch` composes with routes that already bind a host instead of throwing.
