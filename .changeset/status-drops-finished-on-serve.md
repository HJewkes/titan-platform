---
"@titan-design/factory": patch
---

`shepherd.status` takes an optional `all` arg. Without it, and with no PR named, serve leaves finished runs out before loading any, so a bare `shepherd status` no longer parses every run's step results. `shepherd status --all`, or a `--phase` naming a finished phase, sends `all`.
