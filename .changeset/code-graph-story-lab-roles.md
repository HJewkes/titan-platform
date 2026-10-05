---
"@titan-design/code-graph": minor
---

Add the `story` and `lab` file roles. `story` is built in: `*.stories.{js,jsx,ts,tsx}` (with an optional `c`/`m`) and `*.mdx`, checked right after `test`, so the filename beats a `fixtures/` or `scripts/` directory. `lab` has no built-in rule; a repo assigns it, or any role, with `.gitattributes`-style globs in `.codewatch/roles.json`, read by the new `loadRoleGlobs(repoRoot)` and passed to `annotateRoles` as `roleGlobs`. Configured globs beat every built-in heuristic, and `generated` still wins outright. Rule `excludeRoles` accepts both new roles. `INDEX_VERSION` moves to 0.21.0, so the next index of an existing store is a full re-index.
