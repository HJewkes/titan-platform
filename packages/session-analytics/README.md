# @titan-design/session-analytics

Pricing, session classification, roles, episodes, banding and the standing cost report for
mined Claude Code sessions. The pricing, classification, role, episode and band functions are pure. `costReport`
reads a session graph through a read-only connection and never writes it; `writeEpisodes` is
the one function here that writes.

Tier 2 of the titan-platform DAG. It depends on `@titan-design/session-graph` for table
names and on `@titan-design/store-sqlite` for the `Db` type. `zod` is a peer dependency.

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
- `roleFromProfile`, `workerRole(facts)`, `sessionRole(classification, facts)` — worker-v1
  roles, including the standing-peer overlay.
- `buildEpisodes(input, "worker-v1" | "coordinator-v1")` (pure), `readEpisodeInput`,
  `writeEpisodes(graph, sessionIds)` and `assignmentCount(rows)` — provisional episode
  segmentation, written through session-graph's `replaceEpisodes`.
- `initiativeFromCwd(cwd)`, `sessionInitiative(tasks, cwd)` — a session's initiative from its
  task edges, falling back to the `cf_analyze.py` cwd rule.

```ts
import { openDatabase } from "@titan-design/store-sqlite";
import { costReport, renderCostReportText } from "@titan-design/session-analytics";

const report = costReport(openDatabase(graphPath, { readonly: true }), { days: 7 });
process.stdout.write(renderCostReportText(report));
```

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
`gh api -X PUT repos/o/r/pulls/5/merge` reaches the classifier as `gh api PUT pulls/merge`. No
default rule matches that head yet, so it is not a merge.

A tool call belongs to the latest request at or before it in its transcript, the request that
issued it. The `context_contribution` view maps the other way, to the request a block feeds.

session-read keeps `from` and `msg_id` from a channel tag but not its `broadcast` attribute, so
a broadcast is inferred from its `msg_id` reaching more than one session. A multicast to named
recipients counts as a broadcast too.

Coordinator seats spawned with the `opus-coordinator` profile report as `worker:coordinator`.
Before that profile was mapped they fell into `worker:unknown`, and the `coordinator` role held
only human-driven seats.

Full reference: `site/reference/session-analytics.md`.
