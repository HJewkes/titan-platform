---
"@titan-design/active-work": patch
---

Read indexed values in the commands, bootstrap, migrations, lint, decider, sources, workspace-index and top-level modules through forms that type `undefined`, so they pass `noUncheckedIndexedAccess`. Behaviour is unchanged.
