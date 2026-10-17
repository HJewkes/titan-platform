---
"@titan-design/explainer": minor
---

Use the agent package's shared model-free Codex availability check, resolving the
default CLI through PATH and validating required capabilities. codexUnavailable
now returns a promise; CLI callers await it before starting the judge.
