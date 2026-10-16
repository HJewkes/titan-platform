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

## Directory defaults

An optional top-level `defaults` array carries rung defaults: `{ repo, path, fate, task?, milestone?, reason? }` with the
same fate rules as an entry, where `path` is a directory under a root. A file under that directory with no entry of its own is
not reported as unmapped, so a branch cut before a file's entry existed does not lose a validate round to the TP-3180 rule.
Files under a directory with no default still fail as unmapped. Existing entries keep their meaning; a default only covers
files no entry maps. The manifest carries no defaults yet; tp-operator adds them as content under TP-3180 b.

Chosen over exempting PRs whose merge-base predates the manifest (option B) because it needs no git history in the check
(CI checkouts can be shallow), keeps the rule for every branch, and fits the schema as one optional array.

Test files take the fate of the file they test.

## Compensators

`compensators` lists every A.2 compensator (C1 to C36, X1 to X7, the six temporary ones) with `builtBy` and `deletedBy`.
Only the six temporary compensators have a deleting task (D-M3-19, and D-M8-09 for the shadow tooling). The firm and
arguable ones are steady-state in v9.1, so they carry a `reason` instead.

## Checking

```
node scripts/sunset-manifest.mjs check [--agent-chat <checkout>] [--agent-chat-drift fail|warn]
```

Each problem is tagged `overdue` (a delete past its milestone exit), `drift` (a root and the manifest disagree) or `shape`
(a malformed entry). Without `--agent-chat` the agent-chat roots are checked for shape only.

CI checks agent-chat roots against a checkout of its `main`, which moves independently of this repo. A titan-platform
pull request cannot fix drift there, so CI passes `--agent-chat-drift warn`: drift problems in agent-chat roots print as
`::warning::` lines and do not fail. Overdue and shape problems, and every problem in titan-platform roots, still fail.
The default is `fail`. `scripts/sunset-manifest.test.mjs` runs the
titan-platform root in CI, and fails when it gains a file the manifest does not map.

## Milestone exit (D-M0-07)

`milestones.json` is the one file that says which milestones have exited: M0, M1a, M1b, M2 to M8, each with
`exited: false`. A milestone-exit task sets its own entry to `true` or to its exit date in the same change that exits it.
A D-task id gives its milestone (D-M3-12 is M3, D-M1b-02 is M1b), not the entry's `milestone` field. Once a milestone has
exited, the check fails for every `delete` entry of that milestone whose file `git ls-files` still lists. Kept and
surviving files never fail it. The check runs inside `scripts/sunset-manifest.test.mjs`, so the `pnpm test` step of the
validate job carries it; no new workflow was added. Agent-chat roots are covered too once CI passes `--agent-chat`;
an overdue delete there fails even under `--agent-chat-drift warn`.

R15's scoreboard (D-M0-05) does not exist as a file yet, so there is nothing to link from. D-M0-05 links this manifest when it lands.
