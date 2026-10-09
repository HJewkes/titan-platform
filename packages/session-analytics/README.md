# @titan-design/session-analytics

Pricing, session classification, roles, episodes, banding and the standing cost report for
mined Claude Code sessions. The pricing, classification, role, episode and band functions are pure. `costReport`
reads a session graph through a read-only connection and never writes it; `writeEpisodes` is
the one function here that writes.

Tier 2 of the titan-platform DAG. It depends on `@titan-design/session-graph` for table
names, on `@titan-design/store-sqlite` for the `Db` type, and on `@titan-design/session-read`
and `@titan-design/agent-protocol` for the observations the session timeline folds. `zod` is a
peer dependency.

```ts
import { classifySession, contextBand, priceRequest } from "@titan-design/session-analytics";

priceRequest(
  { inputTokens: 4, cacheReadTokens: 129_291, cacheCreation1hTokens: 1_359, outputTokens: 306 },
  "claude-fable-5-1",
  "2026-09-18T14:48:40.512Z",
).costUsd; // 0.07484275
```

## What it exports

- `PRICE_TABLE`, `PRICE_TABLE_VERSION`, `findPrice(model, ts, prices?)` — USD per million
  tokens by longest model prefix, then the latest row effective at `ts`. A prefix matches only
  at a model-id boundary (the id, a `-YYYYMMDD` date, or a `[..]` suffix), so `claude-opus-5`
  never prices `claude-opus-5-5`.
- `priceRequest(tokens, model, ts, prices?)` — the five cost components, `costUsd` and
  `priced`.
- `classifySession(facts)` — `agent_spawned`, `human_interactive`, `headless_sdk` or
  `other_headless`, plus `coordinator` or `adhoc` for human sessions.
- `CONTEXT_BANDS`, `GAP_BANDS`, `bandOf`, `contextBand`, `gapBand`.
- `costReport(db, { since, until, days, top, transcriptsDiscovered, facetVersion, actionRules,
  mechanicalClasses, episodeRoles, noActionClasses, brokerLogLines, handoff })` — the standing cost report as one JSON
  object, and `costReportSchema`, its zod schema. `byAction` gives each role's cost by action
  class, and `mechanicalShare` the cost of the `mechanicalClasses` (default
  `DEFAULT_MECHANICAL_CLASSES`) over the window total, with each role's share over that role's
  cost. `wakeEpisodes` cuts the wakes of the `episodeRoles` (default `DEFAULT_EPISODE_ROLES`:
  `coordinator` and `worker:coordinator`) into episodes; see "Wake episodes" below.
  `handoffThreshold` fits the handoff model per role and model; see "Handoff threshold" below.
- `buildWakeEpisodes`, `summarizeWakeEpisodes`, `episodeNames`, `wakeEpisodesSchema`,
  `WAKE_FROM_KINDS`, `DEFAULT_NO_ACTION_CLASSES` — the pure pieces behind `wakeEpisodes`.
- `handoffThreshold(rows, teleports, agentSessions, options?)`, `sweepK`, `costPerRequest`,
  `isBootAction`, `parseTeleportEvents`, `handoffThresholdSchema` — the pure pieces behind
  `handoffThreshold`.
- `ACTION_CLASSES`, `DEFAULT_ACTION_RULES`, `DEFAULT_MECHANICAL_CLASSES`,
  `classifyRequest(calls, rules?)` — one action class per request from its tool calls: the
  first rule in list order that any call matches, `text-only` with no calls, `other` with no
  match. Rules match a tool name, a Bash command head, or a read or written path.
- `readRequestToolCalls(db, window)` — each request's tool calls as `ActionCall`s, with the
  `command_heads`, `file_read` and `file_write` signals session-read extracted for them.
- `renderCostReportText(report)` — the same report as plain-text tables, ending with
  `LIST_PRICE_CAVEAT` and the price-table and coverage footer.
- `renderCostReportSections(report, sections)`, `COST_REPORT_SECTIONS` — chosen sections of that
  text under the same header, with the caveat and footer last; one question's answer, not the
  whole report.
- `scope` on `costReport` and `cacheTtlReport` options (`ReportScope`: `sessionIds`,
  `agentPrefix` on agent-chat names, `roles`), and `scopeFilter(db, scope)` behind it — narrows
  every request-keyed field to some sessions. Compactions and coverage stay window-wide.
- `roleFromProfile`, `workerRole(facts)`, `sessionRole(classification, facts)` — worker-v1
  roles, including the standing-peer overlay.
- `buildEpisodes(input, "worker-v1" | "coordinator-v1")` (pure), `readEpisodeInput`,
  `writeEpisodes(graph, sessionIds)` and `assignmentCount(rows)` — provisional episode
  segmentation, written through session-graph's `replaceEpisodes`.
- `staleEpisodeSessions(db, ids?)` — the sessions `writeEpisodes` would change, most recently
  active first: see "Stale episodes" below.
- `blockedFlowReport(input)`, `livenessReport(input)`, `reviewFillReport(db, window)` and the
  parsers under them (`parseVerdict`, `parseDenials`, `parseSeatJournal`, `parseBrokerLog`) —
  agent-chat operations reports; see "Blocked flow", "Liveness" and "Review fill" below.
- `initiativeFromCwd(cwd)`, `sessionInitiative(tasks, cwd)` — a session's initiative from its
  task edges, falling back to the `cf_analyze.py` cwd rule.
- `buildSessionTimeline(observations, options?)`, `SessionTimelineAccumulator`,
  `countAtOrBefore(sortedMs, targetMs)` and the `SessionTimeline` types — the read model behind
  a session view; see "Session timeline" below.

```ts
import { openDatabase } from "@titan-design/store-sqlite";
import { costReport, renderCostReportText } from "@titan-design/session-analytics";

const report = costReport(openDatabase(graphPath, { readonly: true }), { days: 7 });
process.stdout.write(renderCostReportText(report));
```

## Session timeline

`buildSessionTimeline(observations, { gapMinMs, maxTextChars, prices })` is a pure fold over
session-read's normalized observations, so it reads Claude Code and Codex sessions alike and
needs no graph. It returns one `SessionTimeline`, plain JSON that a daemon can send as it is:

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

| Field | What it holds |
|---|---|
| `turns` | `TimelineTurn[]`. A user message opens a turn. Each has `user`, `assistant` messages, `toolCalls`, `errorCount`, `tokens`, `costUsd` and `gapBeforeMs`. Sort a turn's messages and tool calls by `seq` to interleave them. |
| `buckets` | `TimelineMinuteBucket[]`, one per clock minute that held activity, with event, message, tool call and error counts, output tokens and cost. |
| `gaps` | `TimelineGap[]`: each idle stretch of `TIMELINE_GAP_MIN_MS` (10 minutes) or more. The bucket and the turn after a gap carry `gapBeforeMs`. The wait on a tool call that later returned is not idle and is never a gap. |
| `tokens` | `TokenTimeline`: one `TimelineTokenPoint` per API request (prompt size, output, cost, running totals, `afterCompaction`), the `CompactionMark`s and the models used. |
| `tools`, `files`, `errors`, `agents` | Calls by name and by session-read tool family, first touch of each file by access, failed calls, and subagent dispatch spans. Each carries ascending `atMs` arrays for `countAtOrBefore`. |
| `totals` | Counts, the four disjoint token classes and the cost. |

Every `*Ms` field is epoch milliseconds. The model holds no time zone, so a session that
crosses midnight is one unbroken run of buckets and the renderer picks the zone. Text is capped
at `TIMELINE_TEXT_CAP` characters with `truncated` set, and each message and tool call keeps the
`byteOffset` of its transcript line for reading the full record. `SESSION_TIMELINE_VERSION`
changes when a field is removed or changes meaning.

A turn's `origin` is `prompt`, `injected` (a harness block such as a channel message or a task
notification, named in `injectedMarker`), `compaction` (a continuation summary) or `none`
(activity before any user message). It is read from the head of the opening text with
session-read's injected markers, so a typed prompt that the harness prefixed with a reminder
block reads as `injected`.

Cost comes from `priceRequest` over `PRICE_TABLE`. The normalized usage has no 5m and 1h split
of cache writes, so every cache write is priced at the 5m rate and the figure under-reads a
session that wrote 1h caches. A source that reports only running totals (`basis: "snapshot"`)
gets token totals and no points, and nothing is priced: `totals.costUsd` and every turn's
`costUsd` are 0, and `totals.requests` is null.

Claude Code writes one compaction as a boundary line and then a summary line. The timeline
reports it as one `CompactionMark`, at the boundary's time, with the summary.

`result()` returns a fresh copy each time, so a result is safe to keep while more observations
are added. `ToolFamily`, the type of a tool call's `family`, is re-exported from session-read.

## Wake episodes

An episode is one arrival that wakes a session and the requests after it, up to the next
arrival in the same transcript. An arrival is a turn-start record or a mid-loop delivery, the
`queued_command` that reaches a busy seat inside a tool loop. A tool result is never an arrival.
Mid-loop deliveries are most of a busy coordinator's events, so leaving them out would show a
handful of expensive wakes and hide the rest.

`wakeEpisodes.byCause` gives, per cause, episodes, mid-loop episodes, requests, cost,
`requestsPerEpisode`, `costPerEpisode`, and the no-action count and cost. Causes are
session-read's, except that `channel_system` is reported as `agent_lifecycle`: agent-chat's
notice that an agent exited or changed state. Requests in the window whose arrival came before
it are counted under `unattributed`.

**No-action rule.** An episode is no-action when every one of its requests has an action class
in `noActionClasses`, by default `read-investigate`, `text-only` and `other`. An episode with no
requests, such as the second report of a burst, is no-action. Anything else, including a
journal write, a PR check or a message, counts as action. The rule reads the TP-501 facet
rather than regexes over tool input, so the default action rules and a seat's own `actionRules`
decide it the same way they decide `byAction`.

**From.** Each episode has a sender kind. `broker` is agent-chat itself, the sender of the
lifecycle notice. `broadcast` is a message whose `msg_id` reached more than one session. `seat`
is a name carried by a top-level session or by a session spawned with a coordinator profile.
`agent` is any other named sender, and `none` is an arrival with no sender. `pairs` is the
sender-by-receiver matrix. A seat sender is named, and every other sender collapses to its kind,
because spawned agents have one-off names.

## Handoff threshold

When should a session hand over to a fresh one? Each session's terms come from its own requests,
main thread only, priced from `PRICE_TABLE` rather than the graph's stored price table:

- **Boot cost B**: the cost of every request up to and including the first action, a dispatch,
  a send (`BOOT_TOOL`) or a file write.
- **Boot fill f0**: the context tokens at that request.
- **Growth g**: the mean rise in fill per request after boot. Only rises count, so a
  compaction's drop does not cancel the growth before it.
- **Read price p**: the model's cache-read rate.

A cycle runs from f0 to the threshold K in n = (K - f0) / g requests, so a request costs
B / n + p x (f0 + K) / 2. `cohorts` averages the terms over each role and model, sweeps K over
`DEFAULT_K_SWEEP` and reports the best K, the extra cost per request at each `configuredK`
(the charter's `teleport_k` and `retire_k`), and the same sweep in `halfBoot`, where only half
the boot is overhead. `sessions` carries the per-session terms and best K. A session with no
boot action, or on an unpriced model, counts in `unbootedSessions`.

`teleports` gives the exit fill of each handover: the fill of the outgoing session's last
request at or before the broker's `teleport_started` line. The package does not open the broker
log. Pass its lines as `brokerLogLines`; the `from` agent id maps to sessions through
`session_origin.agent_id`.

`reviewers` compares `reviewerPrs` reviews (default 10). A fresh reviewer per PR pays its boot
and its own reads each time. A standing reviewer, priced from the `standingRole` cohort, boots
once and then reads a context that every earlier PR grew. A row's requests per PR come from the
reviewer sessions on its own model; a standing model with no reviewers of its own takes the
mean of the newest reviewer cohort, the model whose latest session ends last; `requestsFrom`
names that model. With no reviewer session at all it is 0 and `requestsFrom` is `"pooled"`.
A session with no request after boot does not count toward its cohort's growth. A reviewer's
review often sits inside its boot (its first write or send comes late), so requests per PR
count only what follows it and can understate a reviewer that does its work before it writes.

The report reads a window, so a session that started before it has its boot cut short.

## Cache TTL what-if

`cacheTtlReport(db, { since, until, days })` asks what `CLAUDE_CODE_PROMPT_CACHE_TTL=5m` would
have saved against the 1h TTL. `cacheTtlWhatIf(rows, prices?)` is the pure core over
`TtlRequestRow`s, which `readTtlRows(db, window)` reads with the cost report's roles and each
session's spawn profile. `cacheTtlWhatIfSchema` is its zod schema and `renderCacheTtlText` its
text form.

- **Reprice.** Every 1h write is priced at the 5m write rate instead, from `findPrice`.
- **Rebuild.** A request whose gap falls in `REBUILD_GAP_BANDS` (the `gapBand`s from 5 minutes
  up) finds a 5m cache gone. Its cache read is charged again at the 5m write rate, less the read
  it no longer pays. Past an hour the 1h cache had expired too, so the read is already near zero
  and only the reprice applies.
- **Net.** Per role and per profile: reprice saving less rebuild cost, and the same per session.
  `lossRoles` lists the roles whose net is negative, typically seats that wait on CI.

The gap is the request's `gap_ms` when the miner stored one. Otherwise it is the time since the
session's previous request on the same thread, which may fall before the window.

## Stale episodes

`staleEpisodeSessions(db, ids?)` answers which sessions need `writeEpisodes` again. A session
is stale when its class has a heuristic and its last main-thread request in `request_dedup` is
later than the last episode stored for that heuristic, or none is stored. It chooses the
heuristic through the same `readSessionContexts` and `classifySession` step as
`writeEpisodes`, so the two never disagree about a session. Headless sessions and sessions
with no main-thread request are never stale. `ids` limits the answer to those sessions; the
result is ordered by last request, newest first.

```ts
for (const sessionId of staleEpisodeSessions(graph.db).slice(0, 200)) writeEpisodes(graph, [sessionId]);
```

## Blocked flow

`blockedFlowReport(input)` answers where merges and dispatches stall across the agent-chat
seats. It gives the wait from a reviewer's MERGE verdict to the merge per repo, the PRs still
open with a MERGE verdict, the auto-mode classifier denials by reason, action and seat, and the
minutes a seat sat with free implementer slots, with the reason its journal gave. `renderBlockedFlowText` prints
it and `blockedFlowSchema` is its zod schema.

It is pure and opens nothing. The caller reads four sources and passes the records:

| Input | From | Parser |
|---|---|---|
| `verdicts` | `message` rows of agent-chat's `events.db` whose body starts `Verdict:` | `parseVerdict(body)` reads the block with session-read's gate parser (full 40-hex head, `owner/name#n` PR; null otherwise, which `readVerdicts` counts for `unparsedVerdicts`); `readVerdicts` adds the row's id, time, target seat and sender |
| `pulls` | `gh api repos/<owner>/<repo>/pulls/<n>`, one per PR a verdict names | none; map `.state`, `.merged_at`, `.head.sha` |
| `denials` | each seat's transcript JSONL | `parseDenials(lines, seat)`, which joins each refusal to the tool call it refused |
| `journals` | each seat's dated journal file | `parseSeatJournal(text, seat, date, utcOffsetMin)` reads `HH:MM` lines with `impl <used>/<cap>` and `No dispatch: <reason>` |

`readVerdicts(db, window, seats)` reads the `verdicts` from an `events.db` connection the caller
opened read-only, and counts the refused ones for `unparsedVerdicts`.
`BLOCKED_FLOW_SOURCES` names the command and field behind each section, so a number in the
report can be checked by hand. `asOf` is the moment waits are measured to, `window` clips every
section, `splitAt` splits the wait by verdict time, and `seats` keeps only those seats.

## Liveness

`livenessReport(input)` answers which agents went quiet without saying so: seats dark past
`DARK_MIN` minutes, routed messages that missed their recipient, agents that exited without a
report to their spawner (by spawn profile), and agents stuck on a permission prompt past
`PROMPT_STALE_MIN` minutes. Broker findings cite their broker.log line numbers and prompt
findings their `events.db` row.
`renderLivenessText` prints it and `livenessSchema` is its zod schema.

It is pure and opens nothing. The caller passes:

- `broker`: agent-chat's `broker.log` lines through `parseBrokerLog(lines)`, which keeps each
  JSON entry with its 1-based line number and skips the rest.
- `spawns`: the `agent_spawned` rows of `events.db`, as `SpawnRecord`s (agent id, name,
  profile).
- `lastEvents`: each actor's newest `events.db` row before `asOf`, as `LastEventRecord`s, with
  any resolution or exit row that follows it.

`readSpawns(db)` and `readLastPrompts(db, asOf)` read `spawns` and `lastEvents` from an
`events.db` connection the caller opened read-only.
`LIVENESS_SOURCES` holds the grep and sqlite commands that re-read each section.

### The printed events.db commands run the readers' SQL

Each events.db reader runs one exported constant, `VERDICTS_SQL`, `SPAWNS_SQL` or
`LAST_PROMPTS_SQL`, and its `*_SOURCES` command is `eventsDbCommand(sql)` over that constant.
The command binds each `@name` parameter through sqlite3's `.parameter set` to a placeholder
such as `<asOf epoch ms>`; replace it with epoch milliseconds and the command runs as printed.
The package never opens the file: the caller checks it exists and opens it read-only.
`EVENTS_TABLE_DDL` is agent-chat's events table as the readers expect it, for test fixtures.
`parseTeleportEvents(lines)`, under "Handoff threshold", reads the teleport lines of the same
broker log.

## Review fill

`reviewFillReport(db, window)` answers whether a reviewer's verdicts get worse as its context
fills. It reads the session graph's `pr_review`, `tool_call` and `request` tables, which the
miner fills from transcripts. Each chat verdict is placed in the context band of the request
that sent it, per model, and an approve counts as an error when the same PR later got
`changes_requested`. A GitHub-surface review has no issuing request in the graph and counts in
`unfilled`. It takes an open graph connection, never a path, and does not call `gh`.
`reviewFillSchema` is its zod schema.

## Things that will bite you

Fable's cache read is **0.025** of its input rate, not the 0.1 every other model uses.
Misreading it overstated the 2026-09-20 audit by about $1,700.

An unknown model is **unpriced**: `priced: false` and zero cost. There is no default row,
because defaulting bills a new model at an old model's rate without saying so. The cost
report lists such models under `unpricedModels`.

The cost report prices through the graph's `price` table, not through `PRICE_TABLE`. A graph
whose price rows were never synced reports every request as unpriced, and one synced from an
older `PRICE_TABLE` keeps pricing at the old rates. The cost report takes a caller-opened,
read-only graph and never writes it. Before reporting, the caller must run session-graph's
`reconcilePrices(graph, PRICE_TABLE, { tableVersion: PRICE_TABLE_VERSION, source: "session-analytics" })`
through a writable connection; `titan-miner` does so on every open, other openers do not.

The default action rules are generic. Rules that name a seat's own journal files or scorer
scripts belong in the caller's config, passed as `actionRules`, never in this package. The
defaults read session-read's `command_heads` signal, which keeps only a path's shape, so
`gh api -X PUT repos/o/r/pulls/5/merge` reaches the classifier as `gh api PUT pulls/merge`. The
default rules classify that head as `merge`. Other `gh api` heads stay `other`, except the two
`GET` heads `gh api GET commits/check-runs` and `gh api GET commits/status`, which are
`pr-ci-check`.

A tool call belongs to the latest request at or before it in its transcript, the request that
issued it. The `context_contribution` view maps the other way, to the request a block feeds.

session-read keeps `from` and `msg_id` from a channel tag but not its `broadcast` attribute, so
a broadcast is inferred from its `msg_id` reaching more than one session. A multicast to named
recipients counts as a broadcast too.

Coordinator seats spawned with the `opus-coordinator` profile report as `worker:coordinator`.
Before that profile was mapped they fell into `worker:unknown`, and the `coordinator` role held
only human-driven seats.

Full reference: `site/reference/session-analytics.md`.
