---
"@titan-design/agent-surface": patch
---

Burn down the typed-lint baseline for agent-surface. `readLaunchPlan` now checks the plan's optional fields (`env`, `title`, `surface`, `unsetEnv`, `stdin`) instead of casting the parsed JSON, and subprocess errors are narrowed rather than cast.
