# whiteboard (devdotfast/whiteboard): review summary

## Pin

- Repo: https://github.com/devdotfast/whiteboard at `2ddf3eb6c13d97b1d04a932c21de9a92029adaf9` (2026-10-11).
- `coverage.sh` (LC_ALL=C): `repo=whiteboard head=2ddf3eb6 tracked=7602 read=1581 exempt=5579 dup-of=0 ported-dup=0 glance-code=391 deferred-test=442 unread=0 read-records=3071`.
  Final synthesis label `final`, files under `synthesis/final/`.

## What it is, in titan tiers

whiteboard is a **hitl / dashboard-kit** product for one direction of the human loop: an agent explains code to a
human. A coding agent connects to a local review server over MCP or a JSON CLI, creates a review pinned to a worktree,
a commit range or a GitHub PR, and writes a document of typed blocks that the human reads live in a VS Code fork. The
server validates every block and every source anchor against the pinned commits
(`packages/review/src/review-api/store.ts:L1446-L1576`).

## Integration recommendations (would-be tasks; none filed, per the owner)

**Adopt now** (small, MIT, lands in code that is being built this week)
- **A1. Anchors on OwnerItem and round@2 parts** (from WBT-WF-04). Take the anchor grammar and the accept-time range
  check from `packages/review/src/review-api/authoring-tools.ts:L43-L47` and `store.ts:L1446-L1576`.
- **A2. Anchored selections on OwnerAnswer** (from WBT-HITL-08). Schema from `packages/review/src/agent-selection.ts:L7-L44`.

**Adapt** (needs a titan-shaped design first)
- **B1. Lens list per PR head** (WBT-HITL-13). Source `file-lenses.md`, `diff-lenses.ts`.

## Capability-to-tier table

| tier | whiteboard implementation | verdict | evidence |
|---|---|---|---|
| hitl | anchors, selections, lenses, viewed coverage, presence; no answer path | missing (P1/P2) | `agent-selection.ts:L7-L44`, `store.ts:L1446-L1576` |
| code-graph | diffr structural diff, fold queries, WASM shape plugins | missing as a tool (P3) | `diffr/crates/diffr-core/src/protocol/mod.rs:L1-L5` |
| daemon | loopback server, token auth, desktop supervision | already-have / out-of-scope | `server/hono-http.ts:L87-L103` |

## What we should not do

- **Do not vendor the VS Code fork or the canvas.** 4,998 of 5,464 code-oss files are upstream-identical and the
  value is in ~25 files of delta.
- **Do not copy the live-drawing UX** (draw queue, couriers, WBT-DKB-05). It serves a reader watching an agent.

## Five files to read first

1. `packages/review/instructions/authoring.md` (36 lines): the whole agent workflow and the one fan-out.
2. `packages/review/src/review-api/component-reference.ts` (30 lines) with `blocks/index.ts:L44-L60`: the block vocabulary.
3. `packages/review/src/agent-selection.ts` and `packages/review/src/review-api/http.ts:L1062-L1185`: selection to prompt.
4. `packages/review/src/review-api/store.ts:L1366-L1576`: presence, version race and anchor validation on edit.
5. `packages/trace-core/src/trace-git-hook-runner.ts` and `trace-read.ts:L561-L840`: trailer and blame.

## Owner's four questions

**(a) Main use cases: is it just PRs?** No, but it is only about code. A review targets a worktree, a commit range, or
a GitHub PR, which is optional (`packages/review/src/review-api/document.ts:L123-L138`).
