# review-panel

**Tier 2 · domain.** Depends on [`session-read`](/reference/session-read).

```sh
npm install @titan-design/review-panel
```

Status: types, ports, the classifier (`classifyPr`, `DEFAULT_CLASS_RULES`), the planner (`planPanel`,
`DEFAULT_PANEL_POLICY`, `DEFAULT_PANEL_TABLE`), the reviewer briefs and the verdict acceptor (`acceptVerdict`). The
aggregate lands in a later slice of TP-1916.

## The problem it solves

A pull request review is one reviewer with one brief, wired into Shepherd. A PR that
touches authority or policy needs more than one question asked of it (does it do what it
claims, and does any input read as allowed when it should not), and a second caller, such
as a local CLI, wants the same review without running Shepherd.

This package holds the vocabulary of a review panel and the ports a caller satisfies, so
every caller plans, briefs and aggregates the same way:

- `PrFacts`: what the caller knows about the PR (repo, number, head, base, kind, changed
  files with line counts). Classification reads nothing else.
- `PrClass`: the class (`g10` or `standard`) and the touch flags that choose the panel's
  shapes.
- `PanelPlan`: the members (one per `ReviewShape`), each with its profile, brief id, and
  whether it blocks or was degraded to sonnet, plus a spend estimate.
- `planPanel(cls, policy, headroom)`: the pure planner. The correctness member always
  runs, at the policy's `roles` profile for the class. A `panel` table adds shapes by
  class and touch, in priority order; with no table the plan is correctness alone, which
  is how Shepherd routes its single reviewer today. At most 3 members and 1 opus member;
  a later opus member is planned at its sonnet profile. `headroom.opus === false` plans
  every opus member at its sonnet profile with `degraded: true`.
- `PanelVerdict`: the panel's outcome in Shepherd's vocabulary (`MERGE`, `FIX_FIRST`,
  `no-verdict`, `timeout`), the labelled findings, the dissenting members, and
  `satisfiesG10`.
- The ports `ReviewerDispatch` (roster, spawn, resume), `ReviewerReader` (a reviewer's
  assistant messages) and their rows `ReviewerAgent` and `ReviewerMessage`, with
  `ReviewTarget` naming the head under review.
- `acceptVerdict(input, messages)`: the pure acceptor. It takes only the final message of
  the dispatched agent and session, written after dispatch, whose `Verdict:` block names
  the PR at this head (`namesTarget`; repo case is ignored). A refused or misaimed block
  is `none` with a `malformed` record (`readMalformed`, `MALFORMED_REFUSALS`); a MERGE or
  FIX_FIRST from a session with no investigative call (`isInvestigativeCall`) is `none`
  with `DEPTH_FLOOR_REASON`. A FIX_FIRST keeps its findings (`fixFirstFindings`, bounded
  by `boundedFindings`), and a verdict keeps the reviewer's OWNER-BRIEF block
  (`parseOwnerBrief`).

## When to reach for it

Use it when you start reviewers for a pull request and read their verdicts, and want the
same types Shepherd uses. To start an agent, use
[agent-dispatch](./agent-dispatch.md) inside your `ReviewerDispatch` adapter; this package
never imports it. To parse a transcript into messages for your `ReviewerReader`, use
[session-read](./session-read.md).

## Example

Verified against 0.0.0 (unreleased).

```ts
import type { ReviewerDispatch, ReviewerReader } from "@titan-design/review-panel";

const dispatch: ReviewerDispatch = {
  roster: async () => [],
  spawn: async (name, brief, target) => {
    console.log(`spawn ${name} in ${target.repo} at ${target.head}`);
  },
  resume: async () => {},
};

const reader: ReviewerReader = {
  read: async () => [],
};
```

```ts
import { classifyPr, DEFAULT_PANEL_POLICY, DEFAULT_PANEL_TABLE, planPanel } from "@titan-design/review-panel";

const cls = classifyPr({
  repo: "acme/app",
  pr: 7,
  head: "abc123",
  base: "def456",
  kind: "feature",
  changedFiles: [{ path: ".github/workflows/ci.yml", additions: 4, deletions: 1 }],
});
const plan = planPanel(cls, { ...DEFAULT_PANEL_POLICY, panel: DEFAULT_PANEL_TABLE }, { opus: true });
// plan.members: correctness at bd-reviewer, adversary at reviewer; both blocking
```

## What it deliberately does not do

- It runs nothing. Every side effect (starting an agent, reading a transcript, the clock,
  spawn headroom) is a port the caller passes in.
- It does not import `agent-dispatch`, `workflow`, `github`, or any product.
- Durability is the caller's. Shepherd records each step itself; the package keeps no state.

## Gotchas

- `ReviewerAgent.presence` is a closed union. Map any unlisted roster value to `unknown`,
  which nothing treats as `exited`, `detached` or `deregistered`.
- `ReviewerAgent.predecessor` and `fillTokens` absent mean unknown, and Shepherd never
  resumes such an agent. Report them when your roster knows them.
- `ReviewerReader.read` returns messages oldest first; the last one is the final message.
- `PanelPlan.spendEstimate` is an estimate in agent-chat points, never a cap. The default
  weights (`DEFAULT_MEMBER_POINTS`) are placeholders until the scorecard measures spend.
- A profile counts as opus only when `sonnetFor` maps it to a sonnet profile; an opus
  profile missing from that map is never degraded or capped.
- `tests` is advisory in the plan. Aggregation makes it block when the fix-proof result
  is `vacuous` or `no-tests`.

## Where it came from

Slice 1 of TP-1916. The ports moved from Shepherd's `review.ts` in the factory product,
unchanged, so its `reviewer-dispatch.ts` and `reviewer-reader.ts` adapters satisfy them as
they are. The factory now imports them from here. Slice 3 moved `acceptVerdict`, the
owner-brief parser, the Malformed refusals, `namesTarget` and the depth floor out of
Shepherd's `await-verdict.ts`, `review-schemas.ts`, `verdict-target.ts` and
`depth-floor.ts`, unchanged; a differential test runs a frozen copy of the old acceptor
against recorded messages to prove it.
