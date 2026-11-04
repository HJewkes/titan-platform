---
"@titan-design/active-work": patch
---

Narrow JSON and YAML files read from disk instead of casting them. A malformed refresh-lock holder or launch plan now reads as absent, the artifact hash manifest drops entries that are not strings, and `setup` no longer rewrites an agent-chat `hooks.json` whose hook list is not a list.
