# @titan-design/review-workflow

PR review as a resumable workflow over ports: preflight, heals, a failure taxonomy with a retry policy, and a typed outcome

Tier 2 of the titan-platform DAG. May import only packages in the same tier or
below; the `package-layers` rule in `.codewatch/check.json` enforces this in CI.

## What ships today

- `ReviewWorkflowPorts`: every read and effect a review takes (snapshot, proof read, carry probe, checkout, reviewer
  dispatch and reader, cited-file source, fixer, clock, headroom, and an optional member namer).
- `ReviewStepIds` and `DEFAULT_REVIEW_STEP_IDS`: the ids each step records under. A host with an older record passes its
  own ids so its history stays continuous.
- `ReviewOutcome`: how one review of one head ends. The workflow pushes nothing, so `needs-update` and `conflict` belong to
  the author.
- `FailureClass` and `FAILURE_CLASSES`: why a member reached no verdict.
- `DEFAULT_RETRY_POLICY`: one row per failure class. Each row lists the same-head steps (retry, correct, late read, heal)
  and then a terminal: the fixer, a stop outcome, or none. No row routes to the owner.

- `preflightRead(input, ports)`: the step body that reads the PR, CI, proof standing (with the base the proof judged),
  carry probe, checkout, headroom and installed profiles in one pass.
- `preflight(snapshot, policy)`: pure. In order it stops on a closed or draft PR, a moved head, CI not green, a NO_REPRO
  that ends the review, a carried merge-up, and a behind or dirty head. Then it plans the panel and sends a member whose
  profile is not installed to the fixer, asks for `refresh-checkout` or `await-account` heals in the shape `healOnce`
  takes, and otherwise returns `go` with the plan.
- `planForHead(facts, policy, standing, hold?)`: the class and panel for one head. A hold adds an uncapped adversary,
  and a standing that `needsTestsSeat` adds a blocking tests member.

The retry policy is data. Nothing in this release reads it; the recipe that does arrives in a later release.

```ts
import { DEFAULT_RETRY_POLICY } from "@titan-design/review-workflow";

const timeout = DEFAULT_RETRY_POLICY.find((rule) => rule.class === "timeout");
// { steps: [late-read ×1, retry ×1], then: { kind: "fixer", key: "timeout" } }
```
