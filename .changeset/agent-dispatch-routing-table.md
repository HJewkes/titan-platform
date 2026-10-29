---
"@titan-design/agent-dispatch": minor
---

Add the `./routing` and `./routing/node` subpaths: the `shape-v1` workflow table (schema, lint and the shipped default in `workflow/shape-v1.yml`), `classifyTask`, `profileFor` and `priorRoute`, ported from agent-chat's burndown router. A new `needsOwns` rule field keeps a task whose owns are unknown from routing down; the shipped table sets it on `small` and `standard`.
