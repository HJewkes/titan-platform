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
  tokens by longest model prefix, then the latest row effective at `ts`.
- `priceRequest(tokens, model, ts, prices?)` — the five cost components, `costUsd` and
  `priced`.
- `classifySession(facts)` — `agent_spawned`, `human_interactive`, `headless_sdk` or
  `other_headless`, plus `coordinator` or `adhoc` for human sessions.
- `CONTEXT_BANDS`, `GAP_BANDS`, `bandOf`, `contextBand`, `gapBand`.
- `costReport(db, { since, until, days, top, transcriptsDiscovered, facetVersion })` — the
  standing cost report as one JSON object, and `costReportSchema`, its zod schema.
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

## Things that will bite you

Fable's cache read is **0.025** of its input rate, not the 0.1 every other model uses.
Misreading it overstated the 2026-09-20 audit by about $1,700.

An unknown model is **unpriced**: `priced: false` and zero cost. There is no default row,
because defaulting bills a new model at an old model's rate without saying so. The cost
report lists such models under `unpricedModels`.

The cost report prices through the graph's `price` table, not through `PRICE_TABLE`. A graph
whose price rows were never synced reports every request as unpriced.

Full reference: `site/reference/session-analytics.md`.
