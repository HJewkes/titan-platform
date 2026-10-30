# Stage bumps

A stage's cache key carries its version, so a change to what a stage makes from the same inputs must change that
version, or an old cache entry is read as the new body's output. Re-key a stage by adding one file here:

```json
{ "stages": ["script", "eval"], "why": "Score the outro hold in eval and draft it in script" }
```

Name the file for the change, `<task-id>.json` (`TP-1234.json`; a second bump for the same task is `TP-1234-2.json`).
Each stage's version is its frozen base value in `src/workflow/stage-spec.ts` plus a hash of the ids of every bump that
lists it, so two pull requests bumping the same stage add two files and never collide. A comment or refactor that
leaves a stage's output alone needs no file.

`pnpm stage-version:check` (run in CI with `index-version:check`) refuses a pull request that edits a base value, deletes
or renames a merged bump, or changes a merged bump's `stages`: each would hand a stage a version an older body already
keyed its outputs under. `why` may be reworded.
