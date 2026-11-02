---
"@titan-design/factory": patch
---

The restart drain and the deploy pacer no longer count a run as busy when its `sh-review` step is a spawn the spawn gate deferred and has not admitted. No reviewer was started for it, and the step repeats after the restart, so a loaded machine can no longer hold a deploy indefinitely. A run spawning or running its reviewer still counts as busy, as does an in-flight step that does not spawn. `busyRuns` takes an optional queue predicate, `factoryHealth` takes one as its last argument, and serve wires both from the new `gateQueuedRun`.
