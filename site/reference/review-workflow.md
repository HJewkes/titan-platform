# review-workflow

**Tier 2 · domain.** Depends on [`evidence`](/reference/evidence), [`github`](/reference/github) and
[`review-panel`](/reference/review-panel).

```sh
npm install @titan-design/review-workflow
```

Status: types, ports, step ids, the outcome union, the failure classes and `DEFAULT_RETRY_POLICY`. The recipe
(`reviewHead`), preflight, heals, the fixer and the registrable definition arrive in later releases (TP-3916).

## The problem it solves

review-panel's `reviewPullRequest` runs one head in memory. It has no durable steps and no preflight, and its only
failure handling is one fresh reviewer for a silent member. A caller that hits a hard error, such as a reviewer profile
that is not installed, retries it round after round and spends a reviewer session each time.

This package is the vocabulary for running that review as a resumable workflow:

- `ReviewWorkflowPorts`: every read and effect the review takes. `snapshot` reads the PR, its CI roll-up and the facts
  classification needs; `proofReader` reads the raw `fix-proof/v1` line; `carry` probes for a clean merge-up of a
  signed-off head; `checkout` reports and refreshes the reviewer's read-only checkout; `dispatch` and `reader` are
  review-panel's reviewer ports; `source` reads cited files; `fixer` spawns a diagnosis agent; `clock`, `headroom` and an
  optional `namer` complete the set.
- `ReviewStepIds` and `DEFAULT_REVIEW_STEP_IDS`: the ids the steps record under (`review-preflight`, `review-await` and
  so on). A host with older records injects its own ids so its history stays continuous.
- `ReviewOutcome`: `MERGE`, `FIX_FIRST`, `NO_REPRO`, `carried`, `head-moved`, `needs-update`, `conflict`,
  `account-hold`, `not-open`, `ci-not-green`, `no-verdict`, `needs-fixer` and `proof-spec-problem`.
- `FailureClass` and `FAILURE_CLASSES`: why a member reached no verdict.
- `DEFAULT_RETRY_POLICY`: one `RetryRule` per class.

## When to reach for it

You host a PR review (Shepherd, a CLI, an eval replay) and want the same ports, outcomes and failure rules as every other
host. To run a panel in memory with no durable steps, use [`review-panel`](/reference/review-panel)'s
`reviewPullRequest`. To run steps durably, use [`workflow`](/reference/workflow).

## The retry policy

Each row lists same-head steps, taken in order, then a terminal.

| Class | Steps | Then |
|---|---|---|
| `never-started` | retry ×1 | stop `no-verdict` |
| `start-refused:profile` | none | fixer `profile` |
| `start-refused:headroom` | heal `degrade-headroom` ×1 | stop `no-verdict` |
| `start-refused:other` | retry ×1 | fixer `dispatch` |
| `timeout` | late read ×1, retry ×1 | fixer `timeout` |
| `throttled` | none | stop `no-verdict` |
| `usage-limit` | heal `await-account`, uncounted | none |
| `malformed` | correct ×1, retry ×1 | fixer `parser` |
| `stale-head` | heal `retarget`, uncounted | none |
| `shortfall` | none | stop `NO_REPRO`; fixer `plan-aggregate-mismatch` when the missing seat is not the fix-proof's |
| `deterministic-repeat` | none | fixer `repeat` |
| `schema-drift` | none | fixer `schema` |
| `proof-spec-problem` | none | stop `proof-spec-problem` |

```ts
import { DEFAULT_RETRY_POLICY } from "@titan-design/review-workflow";

const rule = DEFAULT_RETRY_POLICY.find((r) => r.class === "start-refused:profile");
// { steps: [], then: { kind: "fixer", key: "profile" } }
```

Verified against 0.1.0.

## What it deliberately does not do

- It pushes nothing. A head behind its base is `needs-update` and a dirty one is `conflict`; catching up is the author's
  lane.
- No row routes to the owner. A hard error goes to the fixer, which diagnoses it.
- This release reads none of its own data: there is no recipe yet.

## Gotchas

- `throttled` is a `never-started` or `timeout` while the machine stop held. It never reaches the fixer, because nothing is
  wrong with the review.
- A `times: null` step is never counted against a budget: waiting on an account or retargeting a moved head is not a
  failure.

## Where it came from

New, from the TP-3916 plan, which moves PR review out of Shepherd's step bodies and into a workflow any host can run.
