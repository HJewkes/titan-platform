# session-analytics

**Tier 2 · domain.** Depends on [`session-graph`](/reference/session-graph),
[`store-sqlite`](/reference/store-sqlite), [`session-read`](/reference/session-read) and
[`agent-protocol`](/reference/agent-protocol). `zod` is a peer dependency.

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
session class, role, episode count, initiative, context band and wake cause. It also crosses wake cause
with gap band and lists cold rebuilds, compactions, top sessions, unpriced models and
coverage. `byAction` splits each role's cost by the action class of its requests, and
`mechanicalShare` reports the cost of the `mechanicalClasses` over the window total.

`wakeEpisodes` answers what wakes a coordinator and what each wake costs. It cuts the wakes of
the `episodeRoles` (default `coordinator` and `worker:coordinator`) into episodes: one arrival,
turn-start or mid-loop, and the requests up to the next one. Per wake cause it gives requests
and cost per episode, and how many episodes took no action. An episode takes no action when
every one of its requests falls in `noActionClasses`, by default `read-investigate`,
`text-only` and `other`. The agent lifecycle notice is its own cause, `agent_lifecycle`. Each
episode has a sender kind (`seat`, `agent`, `broadcast`, `broker` or `none`), and `pairs` is the
sender-by-receiver matrix. The text renderer lists the ten costliest causes per episode.

`cacheTtlReport(db, { since, until, days })` answers what a 5-minute cache TTL would save
against the 1h TTL that Claude Code writes today. The pure core, `cacheTtlWhatIf(rows)`, reprices
each 1h cache write at the 5m rate. After every request gap of 5 minutes or more (the
`REBUILD_GAP_BANDS` of `gapBand`), it charges a rebuild: the tokens the 1h cache still served
as a read, written again at the 5m rate. It reports the net saving per role and per spawn
profile, and `lossRoles` names the roles whose rebuilds make 5m a loss. `renderCacheTtlText`
prints both tables.

Both reports take an optional `scope` of `sessionIds`, an agent-chat `agentPrefix` and
`roles`, which narrows every request-keyed field; compactions and coverage stay window-wide.
`renderCostReportSections(report, ["byAction", "mechanicalShare"])` prints just those sections
of the cost report, framed by its header, caveat and footer. The session miner's
`titan-miner insights <question>` is built from these two pieces.

## Session timeline

`buildSessionTimeline(observations)` is the read model behind a session view. It folds
session-read's normalized observations, so it covers Claude Code and Codex and needs no graph.
`SessionTimelineAccumulator` is the same fold for a streamed read.

```ts
import { claudeSourceFromPath, readSessionObservations } from "@titan-design/session-read";
import { SessionTimelineAccumulator, countAtOrBefore } from "@titan-design/session-analytics";

const accumulator = new SessionTimelineAccumulator();
for await (const observation of readSessionObservations(claudeSourceFromPath(file, namespace))) {
  accumulator.add(observation);
}
const timeline = accumulator.result();
countAtOrBefore(timeline.tools.atMs, scrubbedMs); // tool calls made by that time
```

The result is plain JSON. `turns` groups messages and tool calls under the user message that
opened them. `buckets` has one entry per clock minute that held activity, and `gaps` lists
each idle stretch of 10 minutes or more. `tokens` has one point per API request with its
prompt size, output, cost and running totals, plus the compaction marks. `tools`, `files`,
`errors` and `agents` are the breakdowns, each with ascending time arrays that
`countAtOrBefore` searches for a scrubbed time.

Every `*Ms` field is epoch milliseconds and the model holds no time zone. A session that
crosses midnight is one unbroken run of buckets, and the renderer picks the zone.

## What it deliberately does not do

It does not read a transcript or the network, it never writes the graph, and it does not
fetch live prices. The timeline takes observations a caller already read.
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

**Roles and episodes are heuristic version 1, and provisional.** A human session is
`coordinator` or `adhoc`. A worker is `worker:<role>`, its spawn profile mapped by the worker
forensics report's table (`PROFILE_ROLES`), with one overlay: a worker living 12 hours or more
that served 2 or more assignments is `worker:standing_peer`. An unmapped profile is
`worker:unknown`; the report's behaviour fallback is not ported.

**Two episode heuristics, on purpose.** `buildEpisodes(input, heuristic)` is pure.
`worker-v1` segments by assignment: it opens at the brief, at a `channel_message` arriving
after a `status_report` in the current episode (channel messages within 10 minutes of the
previous one cluster), and after an idle gap of 30 minutes. It records the first deliverable
and the first status report separately, because a commit fires early in an implementer's
life. `coordinator-v1` segments by work phase: idle gap, PR merge (one per 15 requests),
spawn wave complete, wrap or task done, and a context drop over 20k, with no episode shorter
than 8 requests. `writeEpisodes(graph, sessionIds)` picks the heuristic by session class
(headless sessions get none) and writes through session-graph's `replaceEpisodes`.

**Episodes order by timestamp, transcript id, and byte offset.** `readEpisodeInput(db,
sessionId, spawned)` returns main-thread requests with their `transcriptId`, because a
session resumed into a second transcript restarts its byte offsets. Each episode row records
`startTranscriptId` and `endTranscriptId` (session-graph migration 6). The query ranks only
the copies of request ids that session holds, so reading one session no longer ranks the
whole graph.

**Only assignment episodes count toward standing peer.** An idle-gap episode is the same
assignment resumed, so a worker idle for 13 hours with one brief stays what it was spawned as.

**The report reads stored episodes.** `byEpisodeCount` and the standing-peer overlay read the
`episode` table, so run `writeEpisodes` first; a session never segmented lands under `none`.

**A tool call belongs to the request that issued it.** `readRequestToolCalls` gives each call
to the latest request at or before it in its transcript, then keeps only requests in
`request_dedup`, so a fan-out copy's calls drop out with it. The `context_contribution` view
maps a block the other way, to the request it feeds. Seat-specific action rules (a seat's
journal files or scorer scripts) are passed as `actionRules`; the package keeps generic ones.

**The timeline prices every cache write at the 5m rate.** Normalized usage carries one cache
write count with no 5m and 1h split, so a session that wrote 1h caches under-reads. Use
`costReport` for a figure that must match the audit.

**A turn's `origin` is read from the head of its opening text.** A typed prompt that the
harness prefixed with a reminder block reads as `injected`, not `prompt`.

**A snapshot-only source has token totals and no points.** A source that reports running
totals instead of per-request usage gets `tokens.basis: "snapshot"`, an empty `points` list
and `totals.requests: null`.

**`bandOf` returns `null`, not a fallback label**, for a value no band covers. A negative
gap means clock skew upstream and should be reported rather than bucketed.

## Where it came from

New for TP-263, under the session-mining audit epic TP-256. The price table, the
classification rule order and the band edges are ports of `cf_analyze.py` from the
2026-09-20 cost forensics run, with that script's two inferred-spawn rules dropped (they
fired on zero sessions) and its sonnet default price removed. It also absorbs the package
scaffold TP-239 asked for. The cost report and its renderer are TP-272. Roles and both episode heuristics are TP-273, moved
in from the worker and coordinator forensics reports and `wf_analyze.py` / `co_analyze.py`.

The session timeline is TP-843. It replaces the precompute and binary-search helpers of an
earlier dashboard, and a timeline regex behind them that read clock times with no date.
