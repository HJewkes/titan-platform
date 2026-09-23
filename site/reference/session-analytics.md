# session-analytics

**Tier 2 · domain.** Depends on [`session-graph`](/reference/session-graph) and
[`store-sqlite`](/reference/store-sqlite). `zod` is a peer dependency.

```sh
npm install @titan-design/session-analytics
```

## The problem it solves

A cost and context audit of mined Claude Code sessions needs three answers that nothing in
the graph can give it: what an API request cost, what kind of session made it, and which
bucket a context size or an idle gap falls into. The 2026-09-20 audit answered all three in
a one-off Python script, and one wrong constant in that script overstated the total by about
$1,700.

This package holds those three answers as pure functions with tests, so the next audit reads
them instead of rewriting them. It also holds the standing report built from them:
`costReport` reads a session graph and returns the audit's tables as one JSON object, and
`renderCostReportText` prints that object for a terminal.

## When to reach for it

You have token counts, a model string and a timestamp and you want a cost. You have a
session's origin row and entrypoint and you want its class. You have a context size in
tokens or an idle gap in milliseconds and you want a band label. You have a session graph
and want to know where a week's spend went.

Reading sessions out of a transcript is `@titan-design/session-read`; storing them is
`@titan-design/session-graph`. The graph stores facts and prices them in its `request_cost`
view. Deciding what a session *is* (its class, role and initiative) happens here, so the
graph never grows a policy opinion.

## Example

Verified against 0.1.0.

```ts
import { classifySession, contextBand, priceRequest } from "@titan-design/session-analytics";

const cost = priceRequest(
  { inputTokens: 4, cacheReadTokens: 129_291, cacheCreation1hTokens: 1_359, outputTokens: 306 },
  "claude-fable-5-1",
  "2026-09-18T14:48:40.512Z",
);
// cost.costUsd === 0.07484275, cost.priced === true

classifySession({ startType: "sdk-cli", origin: { depth: 1, profile: "implementer" } });
// { sessionClass: "agent_spawned", humanRole: null, reason: "origin depth >= 1" }

contextBand(130_654); // "100-200k"
```

The cost report takes a read-only connection:

```ts
import { openDatabase } from "@titan-design/store-sqlite";
import { costReport, costReportSchema, renderCostReportText } from "@titan-design/session-analytics";

const report = costReport(openDatabase(graphPath, { readonly: true }), { days: 7, top: 10 });
costReportSchema.parse(report); // the --json shape
process.stdout.write(renderCostReportText(report));
```

`since` is inclusive and `until` exclusive, both compared against request `ts`. `days`
counts back from `until`, or from now. The report groups cost by token class, account, model,
session class, role, initiative, context band and wake cause. It also crosses wake cause
with gap band and lists cold rebuilds, compactions, top sessions, unpriced models and
coverage.

## What it deliberately does not do

It does not read a transcript or the network, it never writes the graph, and it does not
fetch live prices.
`PRICE_TABLE` is a checked-in constant fitted against 392 `cost-state` rows, and
`PRICE_TABLE_VERSION` exists so a report can say which fit produced its numbers.

It does not decide what a session cost **you**. These are list prices; the accounts behind
the audit run on subscription plans. Relative rankings hold, the absolute figure is not a
bill.

## Gotchas

**Fable's cache read is 0.025 of its input rate, not 0.1.** Every other model in the table
reads at a tenth of input. Reading fable the same way is what cost the audit $1,700, and
`fable cache read is 0.025 of input` pins the ratio by name.

**An unknown model returns `priced: false` and zero cost.** There is no default price row.
A default silently bills a new model at an old model's rate, which is worse than a visible
hole; callers are expected to surface `unpriced_models`.

**The origin row beats `startType`.** Agent-chat workers run `claude -p`, so they report
`start_type = "sdk-cli"` exactly like a headless miner. Only the origin row separates them.
A depth-0 origin is the human's own pane, including one that was adopted or inherited.

**AskUserQuestion answers count as `human`.** The report's `human` wake cause holds both
`human_typed` and `ask_user_answer`, with the two visible under `parts`. The 2026-09-20
audit called this its largest interpretive choice ($535); the human settled it this way.
Mid-loop deliveries are counted separately inside every wake cause, because the audit
attributed them to the surrounding tool result.

**Initiative prefers a task edge over the cwd.** A session with a `ran` edge to a task whose
`initiative` is set reports that initiative. Otherwise the `cf_analyze.py` cwd rule gives
`repo:<name>`, `active-work:<name>`, `ac-fork(tmp)` or `other:<basename>`.

**The report prices from the graph's `price` table, not `PRICE_TABLE`.** A graph with no price
rows reports every request as unpriced, and the footer says which table version priced it.

**Roles are provisional.** A human session is `coordinator` or `adhoc`; a worker is
`worker:<profile>` until the profile-to-role map lands.

**`bandOf` returns `null`, not a fallback label**, for a value no band covers. A negative
gap means clock skew upstream and should be reported rather than bucketed.

## Where it came from

New for TP-263, under the session-mining audit epic TP-256. The price table, the
classification rule order and the band edges are ports of `cf_analyze.py` from the
2026-09-20 cost forensics run, with that script's two inferred-spawn rules dropped (they
fired on zero sessions) and its sonnet default price removed. It also absorbs the package
scaffold TP-239 asked for. The cost report and its renderer are TP-272.
