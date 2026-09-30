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
  deletes, and the old paths to remove from the overlay.
- `classifyReports` compares the base and head vitest JSON reports per test and returns a
  verdict: `reproduced`, `unproven`, `vacuous`, `no-tests` or `error`.
- `formatResultLine` and `parseResultLine` encode that verdict as one `fix-proof/v1 <json>`
  log line of at most 4 KB, for a CI job to print and Shepherd to read.

## When to reach for it

Use it to decide whether a fix PR's tests prove the fix, given a diff and two vitest reports
you already hold. The package runs no git, vitest or filesystem calls. The runner that checks
out the overlay, builds and runs vitest is a separate slice (TP-538 S2). To decide who may merge
once a check passes, use [authority](./authority.md).

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
selected. It is `error` when a report is malformed, lists a file twice, or holds none of the
selected files.

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
  an unknown field, duplicate or reordered keys, and a `reproduced` verdict with no
  reproducing test.

## What it deliberately does not do

No git, no vitest, no filesystem and no network calls. It does not decide whether a task
needs the gate; that is the caller's policy (TP-538 section 4). It does not re-run a vacuous
base to rule out a flake; the runner does that.

## Gotchas

- `planFixProof` refuses git's quoted paths. Run git with `-c core.quotePath=false`, which
  leaves only paths holding a tab, newline or quote quoted, and treat the refusal as `error`.
- `formatResultLine` drops `tests` entries first, then `deletedTests`, then `notCollected`,
  to fit 4 KB, and sets `truncated`. The `counts` always cover every test.
- `formatResultLine` throws on a result `parseResultLine` would refuse, such as an
  abbreviated sha.
- Both results and plans are returned as `{ ok: false, error }` rather than thrown.

## Where it came from

New in TP-541, the first slice of TP-538. Before it, only a reviewer reverting the fix by
hand could tell a reproducing test from a vacuous one.
