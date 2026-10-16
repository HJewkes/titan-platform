# fix-proof

**Tier 0 · primitives.** No dependencies at all.

```sh
npm install @titan-design/fix-proof
```

## The problem it solves

A fix pull request should carry a test that fails without the fix. Reviewers rarely check
this by hand, so a fix can ship with a test that passes on the old code too and proves
nothing. The fix-proof gate runs the PR's added or changed tests twice: once over the merge
base with the PR's non-test changes removed, and once at head. A test that fails on base and
passes on head reproduces the bug.

This package is the pure core of that gate. It adds three primitives:

- `planFixProof` turns `git diff -M --name-status <mergeBase> <head>` and the merge base's
  `.github/fix-proof.json` into the tests to run, the support files to carry, the tests the PR
  deletes, and the old paths to remove from the overlay. It also lists the PR's mutation specs
  (`mutations`) and every path that is not test material (`source`); `testOnlyOf(plan)` is
  true when `source` is empty.
- `classifyReports` compares the base and head vitest JSON reports per test and returns a
  verdict: `reproduced`, `unproven`, `vacuous`, `no-tests` or `error`.
- `formatResultLine` and `parseResultLine` encode that verdict as one `fix-proof/v1 <json>`
  log line of at most 4 KB, for a CI job to print and Shepherd to read.

## When to reach for it

Use it to decide whether a fix PR's tests prove the fix. Call the pure functions when you
already hold a diff and two vitest reports, or run the `fix-proof` bin in CI to produce them.
To decide who may merge once a check passes, use [authority](./authority.md).

## The runner

The bin has three subcommands. In CI each runs in its own job, so code from the PR head never
runs in the job that prints the verdict.

```sh
fix-proof exec --side base|head --out <dir> [--sandbox-user <name>] --base <mergeBase> --head <sha> [--repo <dir>] [--budget-ms <n>]
fix-proof judge --base-report <file> --head-report <file> [--base-rerun-report <file>] --base <mergeBase> --head <sha> [--repo <dir>] [--budget-ms <n>]
fix-proof run --base <mergeBase> --head <sha> [--repo <dir>] [--budget-ms <n>]
```

**`exec`** builds and tests one side and writes encoded reports to `<dir>`. It prints nothing
when it succeeds.

1. Plans the diff `git diff -M --name-status <base> <head>` with the base's config.
2. Adds a detached worktree at that side's commit. It runs `pnpm install --frozen-lockfile`
   when a `pnpm-lock.yaml` is present, then the config's `build` (default `pnpm build`).
3. On the base side only, it then checks out the head's tests and carried files over the tree
   and removes `overlayRemovals`. The base install and build finish before any head file lands,
   so nothing the PR carries runs during them, and the base run still lacks the fix.
4. Runs the config's `command` (default `pnpm exec vitest run`) with
   `--reporter=json --outputFile <tmp> --testTimeout 30000 <tests>` appended. The base side runs
   it twice, as `base.report` and `base-rerun.report`, so a reproducer that flaked green once
   can be ruled out. The head side writes `head.report`.
5. Each report keeps only the fields the classifier reads, with repo-relative paths, and is
   gzipped and base64-encoded: no space or newline, so it fits a job output and can never form a
   `fix-proof/v1 ` log line. A failed git call, install or build, a missing vitest report or the
   `--budget-ms` deadline (default 18 minutes) writes an error marker in place of each report.

**The base-side sandbox.** The base side runs head test code on the runner. Without a sandbox, a
`setsid` child of a head test outlives vitest under the job's own uid and can rewrite the base
reports before they are passed on. `--sandbox-user <name>` closes that:

- The tree's directories and a fresh output directory per run are handed to that user. Files
  stay runner-owned, because pnpm hardlinks `node_modules` files to its store.
- Each vitest run is `sudo -n -- timeout -k 5 <budget> unshare --pid --fork --kill-child
  --mount-proc -- setpriv --reuid <name> --regid <name> --init-groups --no-new-privs
  --bounding-set=-all -- env -i PATH=… HOME=<tree> CI=1 sh -c <command>`. Every process the
  tests start dies when the namespace's init exits, and none can regain root.
- A user that resolves to uid 0 or to the runner's own uid is refused as a setup failure.
- The vitest output is read only as a regular file of at most 16 MiB, never through a symlink.
- Everything is handed back to the runner afterwards so cleanup can remove it.

A failed `sudo` setup writes an error marker for both base reports; vitest never falls back to an
unsandboxed run. The head side ignores the flag. The caller creates the user, which must not be
able to `sudo`. Code running inside the sandbox during the
run can still rewrite that run's own vitest output, as the test itself could by failing on
purpose; the sandbox removes the survivors, not the test code's own reach.

**`judge`** reads the report files and prints one `fix-proof/v1` line.

- It plans the diff from git itself, so a report entry outside its own plan counts nowhere.
- It decodes each file under a 900 KB encoded and an 8 MB inflated cap. A missing, oversized,
  malformed or error-marker report gives an `error` verdict naming the side.
- It spawns nothing but git (`rev-parse`, `diff`, `ls-tree`, `show`) and builds neither commit.
- `dist/judge.js` is `fix-proof judge` as its own entry. It cannot run `exec` or `run`, and its
  presence in a merge-base build tells the CI script that the base supports the split.

**`run`** runs both sides and then the judge in one process: the local mode, with the same
verdict as the three jobs.

Every subcommand exits 0. Bad arguments or any failure give an `error` line instead; the
deadline's error is `timeout`. Worktrees are removed either way.

`command` and `build` run under `sh -c`, so they come from the merge base's config only. Build
the runner itself from the merge base too, never from the PR's tree.

### The three CI jobs

| Job | Runs | Hands on |
| --- | --- | --- |
| `fix-proof-base` | `exec --side base` | `base.report` and `base-rerun.report` as job outputs |
| `fix-proof-head` | `exec --side head` | `head.report` as a job output |
| `fix-proof` | `judge` from a merge-base build, after both | the verdict line Shepherd reads |

A head install or build can rewrite its own tree, its report or the vitest config of anything
it can reach, and it can leave a detached process that prints a forged line later. None of that
reaches another job's machine, outputs or log, and the judge job runs no head code. A repo that
copied the old single-job workflow keeps that weaker model until it adopts the three jobs.

**Accepted residual.** The head's tests and carried support files still run on the base side,
because they are what is being proved. A test that detects the base and fails on purpose can
fake `reproduces`. That is test content, for the reviewer who reads the tests; the runner cannot
rule it out.

## Example

Verified against 0.0.0 (unreleased).

```ts
import { classifyReports, formatResultLine, planFixProof, toResult } from "@titan-design/fix-proof";

const planned = planFixProof({
  nameStatus: "M\tsrc/parse.ts\nA\tsrc/parse.test.ts\nR100\tsrc/old.test.ts\tsrc/moved.test.ts\n",
  baseConfig: null, // the merge base has no .github/fix-proof.json
});
if (!planned.ok) throw new Error(planned.error);
planned.plan.tests; // ["src/parse.test.ts"]: the pure rename is not a new test

const run = (status: "passed" | "failed", failure?: string) => ({
  testResults: [
    {
      name: "/ci/repo/src/parse.test.ts",
      status,
      assertionResults: [{ fullName: "parse keeps quotes", status, failureMessages: failure ? [failure] : [] }],
    },
  ],
});
const classification = classifyReports({
  selected: planned.plan.tests,
  base: { root: "/ci/repo", report: run("failed", "AssertionError: expected 'a' to be '\"a\"'") },
  head: { root: "/ci/repo", report: run("passed") },
});
classification.verdict; // "reproduced"

formatResultLine(toResult({ head: "1".repeat(40), mergeBase: "2".repeat(40), plan: planned.plan, classification }));
// fix-proof/v1 {"head":"1111…","mergeBase":"2222…","verdict":"reproduced","counts":{"reproduces":1,…},…}
```

## Classification

Each test in the head report is compared with the same full name in the base report.
Duplicate names pair up by occurrence.

| Class | Base | Head |
| --- | --- | --- |
| `reproduces` | failed, including a timeout | passed |
| `passes-on-base` | passed | passed |
| `new-api` | suite load error, or a failure naming a missing symbol | passed |
| `fails-on-head` | anything | failed |
| `not-run` | skipped or absent | passed, or head skipped it |

A missing symbol is a failure containing `is not a function`, `is not a constructor`,
`Cannot find module`, `does not provide an export` or `Failed to load url`. vitest does not
typecheck, so a test for a brand-new export fails on base this way without proving anything.

The verdict is `reproduced` when any test reproduces. Otherwise it is `unproven` when any test
is `new-api`, and `vacuous` in every other case. The verdict is `no-tests` when nothing was
selected. It is `error` when a report is malformed, lists a file twice, holds none of the
selected files, or when any selected file is missing from the head report or fails to load
there, even if another file reproduces.

## Direction rule

Every ambiguous, missing or malformed input classifies away from `reproduced`.

- **Globs come from the base config.** `planFixProof` reads `baseConfig` only. `headConfig`
  sets `configEdited` so the reviewer hears about the edit; it never changes the plan.
- **Report paths match exactly.** vitest treats path arguments as substring filters, so a run
  selecting `a.test.ts` also runs `data.test.ts`. `classifyReports` keeps a file only when its
  path below `root`, after resolving `.` and `..`, equals a selected path. Relative names and
  paths outside `root` are ignored.
- **Renames keep their identity.** An `R100` test rename selects nothing. A partial rename
  (`R087`) runs the new path and lists the old one in `overlayRemovals`. A deleted test lands
  in `deletedTests` and never runs.
- **A failure on both sides is not proof.** A test that fails at head is `fails-on-head`
  whatever base did.
- **Result lines are strict.** `parseResultLine` refuses a line over 4 KB, another version,
  an unknown field, duplicate or reordered keys, a `reproduced` verdict with no
  reproducing test, and a `killed` mutants verdict over a mutant that was not killed.

## Test-only diffs and mutation specs

A PR that only adds or changes tests, such as a characterization test, is vacuous under
base-vs-head by construction. For such a PR the gate asks for mutations instead (TP-2732).

- **Test-only.** A changed path is test material when it matches the base config's `tests` or
  `carry` globs, `MUTATION_SPEC_GLOB` (`**/*.mutations.json`) or `CHANGESET_GLOB`
  (`.changeset/*.md`), and is not under `FIX_PROOF_HARNESS`. Every other path, deleted ones and
  both sides of a rename included, lands in `plan.source`. A copy's old path is unchanged, so it
  does not count.
- **Spec files.** A spec sits next to its test as `<test file minus extension>.mutations.json`,
  for example `serve.test.mutations.json` beside `serve.test.ts`. Its shape is
  `{ v: 1, mutations: [{ name, file, find, replace, kills }] }`.
- **`parseMutationSpec(text)`** is strict. It refuses unknown keys, more than 5 mutations or
  none, a duplicate or over-80-character `name`, a `find` or `replace` over 400 characters, a
  `find` equal to its `replace`, an unnormalized `file`, and an empty or duplicate `kills` list.
- **`checkMutation(mutation, baseText, config)`** checks one mutation against the merge base.
  Its `file` must exist there (`baseText` null means it does not) and must not be a test, a
  carried file, a spec, a changeset or a harness path. Its `find` must occur exactly once,
  counting overlapping matches.

**The mutation check.** For a diff of test material alone that adds or changes a spec, the
judge adds `mutants: { verdict, results: [{ spec, name, outcome, failed? }], error? }` to the
`fix-proof/v1` line. Any other diff gets no `mutants` field.

- **Reading the specs.** The judge reads each spec at head with git and runs `checkMutation`
  on it against the merge base. It pairs the spec with the one test file beside it
  (`testFileOfSpec`). A spec that does not parse, fails the check or has no single test beside
  it makes the field `{ verdict: "error" }`. The base-vs-head verdict is left alone.
- **The mutants report.** The mutants side writes one report with `encodeMutantsReport`: a
  baseline run of the merge base with the head's tests overlaid, then one run per mutation. A
  run is keyed by spec path and mutation name. The judge decodes it with
  `decodeMutantsReport`. A run named twice makes the report unreadable, and runs no spec
  declares are ignored. A skipped marker (`encodeMutantsSkipped`) or an error marker gives
  verdict `error`.
- **Outcomes.** `classifyMutants` gives each mutation one outcome, and the verdict is `killed`
  only when every outcome is.
  - `killed`: the mutant built, and the tests that fail under it are exactly its `kills`.
    Every one of those failures is an assertion failure.
  - `overkill`: every `kills` test failed, and so did another test.
  - `survived`: some `kills` test still passed.
  - `unbuilt`: the rebuild failed under the mutation.
  - `load-error`: the test file failed to load, or some test failed with a load or new-API
    message, such as `Cannot find module`.
  - `baseline`: a `kills` test did not pass exactly once in the baseline.
  - `error`: the mutation's run is missing, or some test failed with anything but an
    `AssertionError` (from an `expect` matcher or `node:assert`). A thrown TypeError, a
    timeout or a crash is not a kill. Neither is a failure from `.rejects` or `.resolves`,
    because vitest reports those as a plain `Error`.
- **Fitting the 4 KB line.** `failed` lists the failing tests only for `overkill` and
  `survived`. To fit the line, the judge drops `killed` results before the others and keeps
  the verdict.
- **Old parsers.** A parser from before this field refuses the line as an unknown field. A
  Shepherd that has not been redeployed therefore reads the proof as an error.

Carried files count as test material on path alone. A fix placed in a carried file that
production code imports would pass as test-only.

## What it deliberately does not do

The pure functions make no git, vitest, filesystem or network calls; only `execSide`, `judge`, `run` and the bin do.
It does not decide whether a task
needs the gate; that is the caller's policy (TP-538 section 4). `classifyReports` does not re-run
a vacuous base to rule out a flake; the base `exec` side runs it twice for that.

## Gotchas

- `planFixProof` refuses git's quoted paths. Run git with `-c core.quotePath=false`, which
  leaves only paths holding a tab, newline or quote quoted, and treat the refusal as `error`.
- `formatResultLine` drops `tests` entries first, then `deletedTests`, then `notCollected`,
  to fit 4 KB, and sets `truncated`. The `counts` always cover every test.
- `formatResultLine` throws on a result `parseResultLine` would refuse, such as an
  abbreviated sha.
- Both results and plans are returned as `{ ok: false, error }` rather than thrown.

## Where it came from

New in TP-541, the first slice of TP-538; the runner and bin came in TP-542, and the exec and judge split in TP-2406. Before them, only a reviewer reverting the fix by
hand could tell a reproducing test from a vacuous one.
