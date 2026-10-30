# review-workflow

**Tier 2 · domain.** Depends on [`evidence`](/reference/evidence), [`github`](/reference/github),
[`review-panel`](/reference/review-panel) and [`workflow`](/reference/workflow).

```sh
npm install @titan-design/review-workflow
```

Status: types, ports, step ids, the outcome union, the failure classes, `DEFAULT_RETRY_POLICY`, heals, the fixer,
preflight, the recipe (`reviewHead`, `REVIEW_STEP_BODIES`) and the registrable definition with a standalone runner
(`reviewWorkflow`, `reviewRunner`).

## The problem it solves

review-panel's `reviewPullRequest` runs one head in memory. It has no durable steps and no preflight, and its only
failure handling is one fresh reviewer for a silent member. A caller that hits a hard error, such as a reviewer profile
that is not installed, retries it round after round and spends a reviewer session each time.

This package is the vocabulary for running that review as a resumable workflow:

- `ReviewWorkflowPorts`: every read and effect the review takes. `snapshot` reads the PR, its CI roll-up and the facts
  classification needs; `proofReader` reads the head's fix-proof as `@titan-design/fix-proof`'s `ProofReadInput`; `carry` probes for a clean merge-up of a
  signed-off head; `checkout` reports and refreshes the reviewer's read-only checkout; `dispatch` and `reader` are
  review-panel's reviewer ports; `source` reads cited files; `fixer` spawns a diagnosis agent; `profiles` says whether an
  agent profile is installed; `clock`, `headroom` and an optional `namer` complete the set.
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

## Preflight

`preflightRead({ target, policy, hold? }, ports)` reads everything once and returns a `PreflightSnapshot`, including the
proof standing and the base the proof judged. `preflight(snapshot, policy)` is pure and checks in this order:

1. not open (draft, closed, merged), head moved, CI not green: `stop`;
2. a NO_REPRO that `endsReview`: `stop(NO_REPRO)`, waivable only for CI's own failed proof of a workflow-only diff;
3. a carried merge-up: `stop(carried)`; mergeable state `behind` or `dirty`: `stop(needs-update)` or `stop(conflict)`;
4. the plan (`planForHead`): a member whose profile is not installed gives `fixer` with case
   `start-refused:profile` and the profile as detail, before any member starts;
5. a checkout that is not ready, or a held account: `{ kind: "heal", heals }`, the shape `healOnce` takes;
6. otherwise `go` with the plan.

```ts
import { preflight, preflightRead } from "@titan-design/review-workflow";

const decision = preflight(await preflightRead({ target, policy }, ports), policy);
// { kind: "fixer", fixerCase: { failure: "start-refused:profile", key: "profile", detail: ["reviewer"] } }
```

## The recipe

`reviewHead(host, input, policy)` reviews one full head. The host passes `call(stepId, input, schema)`, which records a
step and returns its answer; Shepherd binds it to its own `step`, a standalone run to `@titan-design/workflow`'s
`codeStep`. Each step's body is in `REVIEW_STEP_BODIES` under its `ReviewStepIds` key, so the host registers the bodies
and the recipe stays control flow only.

1. `preflight`, then at most one heal pass and one re-read; a decision that still asks for a heal goes to the fixer as
   `heal-ineffective`.
2. `intent` records the plan. Every member is dispatched before any is awaited.
3. Each member walks its class's row: `classifyFailure` names the class, and the row's steps run in order within the
   member's budget. One fresh retry per member, under the attempt-2 name, whichever class asked for it.
4. `aggregate` over every member's result, then the outcome: `MERGE`, `FIX_FIRST`, `NO_REPRO` for a fix-proof shortfall,
   or `no-verdict` with the classes that were spent.

A member with a verdict is settled and never dispatched again, so tp#2145's two MERGEs cost two sessions, not eight. The
same refusal twice (a malformed reply after its correction, or a spawn refused with the same text) goes to the fixer at
once. With `historyNext`, a step the recipe added is skipped when a replayed record names another step there: a run
recorded before preflight reads its plan from the intent.

```ts
import { reviewHead } from "@titan-design/review-workflow";

const outcome = await reviewHead({ call: (id, input, schema) => codeStep(ctx, id, input, schema) }, input, { plan: policy });
// { kind: "needs-fixer", fingerprint: "parser:no_block", failure: "malformed", head }
```

## The standalone runner

`reviewWorkflow({ ports, policy, ids?, version? })` is the recipe as one `@titan-design/workflow` definition: its `run`
binds `call` to `codeStep` and `historyNext` to the context's, and `reviewRoutes(ports, ids)` gives one inline code route
per step body. A host registers `run` under `version` (`REVIEW_WORKFLOW_VERSION` by default) and runs it over
`routedRunner(routes)`. The outcome is seeded into the run's params, and `reviewOutcomeOf(run)` reads it back.

`reviewRunner` does exactly that over a runtime you pass the store and gates for. `start(request)` returns the run id,
`outcome(runId)` waits for it, and `hydrate()` resumes what an earlier process left. A run stopped mid-await resumes from
its record: the dispatch steps replay, so no member is spawned twice. A run pinned to another definition version parks as
`recovery_required` instead of replaying. `resolve(fingerprint)` takes every run parked on a fixer fingerprint off the
`parking` port and reviews it again as a fresh run of its original request.

```ts
import { reviewRunner } from "@titan-design/review-workflow";

const runner = reviewRunner({ ports, policy: { plan }, runtime: { db, gates } });
await runner.hydrate();
const outcome = await runner.outcome(runner.start({ target, kind: "feature", brief }));
// { kind: "MERGE", head, verdict }
```

Bump `REVIEW_WORKFLOW_VERSION` whenever a recorded run would replay differently.

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
| `heal-ineffective` | none | fixer `heal-ineffective` |

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
- `reviewHead` reviews full heads only. Shepherd keeps its scoped re-review until it calls the recipe.
- The recipe does not yet detect `throttled`, `stale-head`, `deterministic-repeat`, `schema-drift` or
  `proof-spec-problem`; their rows are data for the hosts that will.
- The fixer only proposes; it changes nothing (owner question TP-3916 Q1).

## Gotchas

- `throttled` is a `never-started` or `timeout` while the machine stop held. It never reaches the fixer, because nothing is
  wrong with the review.
- A `times: null` step is never counted against a budget: waiting on an account or retargeting a moved head is not a
  failure.

## Where it came from

New, from the TP-3916 plan, which moves PR review out of Shepherd's step bodies and into a workflow any host can run.
