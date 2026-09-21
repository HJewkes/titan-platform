# @titan-design/session-analytics

Pricing, session classification and banding for mined Claude Code sessions. Pure functions
over plain objects: no database, no filesystem, no network.

Tier 2 of the titan-platform DAG. It imports no other titan package; a caller composes it
with `@titan-design/session-read` and `@titan-design/session-graph`.

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

## Two things that will bite you

Fable's cache read is **0.025** of its input rate, not the 0.1 every other model uses.
Misreading it overstated the 2026-09-20 audit by about $1,700.

An unknown model is **unpriced**: `priced: false` and zero cost. There is no default row,
because defaulting bills a new model at an old model's rate without saying so.

Full reference: `site/reference/session-analytics.md`.
