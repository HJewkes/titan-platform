# Old-code sunset manifest (D-M0-06)

`manifest.json` maps every file of the old pipeline to one fate, so the v9.1 deletions are checkable.
D-M0-07's CI check reads it. The task stays open while any listed root has a file the manifest does not map.

## Roots

| Repo | Root |
|---|---|
| titan-platform | `products/factory/src/shepherd` |
| agent-chat | `src/agents/burndown` (the burndown code) |
| agent-chat | `scripts/seat` |

`scripts/seat/**` does not exist in titan-platform. It lives only in agent-chat, so those entries carry `"repo": "agent-chat"`.
The lists come from `git ls-files`, and fixtures and test data are listed too.

## Entry fields

- `fate: "delete"`: `task` is the deleting D-task, `milestone` its rung, `filing` its TP or CC id (from the v9.1 filing map).
- `fate: "survives"`: the file survives as a step body of `task`; `reason` says why.
- `fate: "kept"`: `reason` says why. A reason starting `unclear:` is a question for the owner; no D-id was guessed.

Test files take the fate of the file they test.

## Compensators

`compensators` lists every A.2 compensator (C1 to C36, X1 to X7, the six temporary ones) with `builtBy` and `deletedBy`.
Only the six temporary compensators have a deleting task (D-M3-19, and D-M8-09 for the shadow tooling). The firm and
arguable ones are steady-state in v9.1, so they carry a `reason` instead.

## Checking

```
node scripts/sunset-manifest.mjs check [--agent-chat <checkout>]
```

Without `--agent-chat` the agent-chat roots are checked for shape only. `scripts/sunset-manifest.test.mjs` runs the
titan-platform root in CI, and fails when it gains a file the manifest does not map.

R15's scoreboard (D-M0-05) does not exist as a file yet, so there is nothing to link from. D-M0-05 links this manifest when it lands.
