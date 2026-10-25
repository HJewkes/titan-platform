---
"@titan-design/factory": minor
---

Add `titan-factory shepherd watch <ref> [--on merged,stopped,gated] [--seat <name>]`, `shepherd unwatch <ref>` and `shepherd watch --list` (TP-4208), backed by the new `shepherd.watch` command. A watched run's named events are prompt-class in the paced seat digest, so they arrive after the settle window rather than the batch flush. A watch is dropped once the digest that reports its run finished is sent, and it is kept in the factory database, so it survives a serve restart. Watching a PR Shepherd has not registered exits 1 with the reason.
