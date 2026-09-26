# titan-platform

Reusable `@titan-design/*` packages arranged as a strict acyclic DAG, plus the products
composed thinly on top of them. This is the destination monorepo for the Titan platform
decomposition: shared concerns that grew independently in brain, active-work, codewatch,
and the session-miner get extracted here one package at a time, and each old repo keeps
running on the published packages until its capability is rebuilt here.

**Documentation: <https://hjewkes.github.io/titan-platform/>** — what each package does,
when to reach for it, worked examples, the architecture, and the case studies.

**Before you build anything, read [CAPABILITIES.md](CAPABILITIES.md).** It lists every
package, product and app with its purpose, a "use this when" line, and its key exports. It
also lists the proven runtime paths with the credential each one needs, and the known gaps.
`pnpm capabilities` regenerates it, and CI fails when it is stale.

## Layout

```
packages/     the shared tiers (published to npm as @titan-design/<name>)
products/     apps composed from the tiers (private)
templates/    the uniform per-package scaffold that scripts/new-package.mjs stamps
scripts/      new-package.mjs, dag-check.sh, gen-docs-reference.mjs, gen-capabilities.mjs
site/         the documentation site (VitePress)
.codewatch/   check.json: the DAG and fitness rules codewatch enforces
```

## The DAG

A package may import only packages in its own tier or a lower one. Never sideways across a
higher tier, never upward. Tier 0 holds primitives and shared wire contracts, tier 1 engines,
tier 2 domain modules, and `ui` React bindings for the daemon wire. Every package versions
independently through changesets.

| Tier | Package | What it does |
|---|---|---|
| 0 | [`@titan-design/store-sqlite`](https://hjewkes.github.io/titan-platform/reference/store-sqlite) | SQLite table-factory kit: bi-temporal edges, entities, contentless FTS5, watermarks, cache blobs, migrations |
| 0 | [`@titan-design/locator`](https://hjewkes.github.io/titan-platform/reference/locator) | byte-offset provenance locators into JSONL files, and raw-mirror durability |
| 0 | [`@titan-design/cluster`](https://hjewkes.github.io/titan-platform/reference/cluster) | deterministic Drain template mining with pluggable line masking |
| 0 | [`@titan-design/embed`](https://hjewkes.github.io/titan-platform/reference/embed) | local, Ollama, or remote embeddings with a zero-download hash fallback |
| 0 | [`@titan-design/agent-protocol`](https://hjewkes.github.io/titan-platform/reference/agent-protocol) | harness-neutral identity, execution-phase, and usage contracts |
| 0 | [`@titan-design/chat-protocol`](https://hjewkes.github.io/titan-platform/reference/chat-protocol) | the canonical chat message document and envelope agent-chat surfaces speak |
| 0 | [`@titan-design/code-parser`](https://hjewkes.github.io/titan-platform/reference/code-parser) | tree-sitter WASM parsing for TypeScript, TSX, and Python, and the `Extractor` contract |
| 0 | [`@titan-design/rpc-protocol`](https://hjewkes.github.io/titan-platform/reference/rpc-protocol) | dependency-free daemon wire contract: envelope, exit codes, routes, SSE vocabulary |
| 0 | [`@titan-design/evidence`](https://hjewkes.github.io/titan-platform/reference/evidence) | citation verification, overlap grouping, and planted-control scoring for model-judged evidence |
| 1 | [`@titan-design/retrieval`](https://hjewkes.github.io/titan-platform/reference/retrieval) | FTS, vector, and graph retrieval fused with RRF, a rerank cascade, and fail-open |
| 1 | [`@titan-design/agent`](https://hjewkes.github.io/titan-platform/reference/agent) | headless Claude Code and Codex runs with an env scrub, a failure taxonomy, and hard budgets |
| 1 | [`@titan-design/agent-lifecycle`](https://hjewkes.github.io/titan-platform/reference/agent-lifecycle) | durable agent execution ledger with fenced ownership |
| 1 | [`@titan-design/registry`](https://hjewkes.github.io/titan-platform/reference/registry) | one zod command definition projected to CLI, MCP, and HTTP |
| 1 | [`@titan-design/daemon`](https://hjewkes.github.io/titan-platform/reference/daemon) | hono host: `/rpc`, `/mcp`, SSE events, file watch, and process lifecycle |
| 1 | [`@titan-design/hitl`](https://hjewkes.github.io/titan-platform/reference/hitl) | the human-in-the-loop `gate()`/`resolve()` primitive |
| 1 | [`@titan-design/messaging`](https://hjewkes.github.io/titan-platform/reference/messaging) | runtime-neutral messaging transport with BlueBubbles and Telegram adapters |
| 1 | [`@titan-design/rpc-client`](https://hjewkes.github.io/titan-platform/reference/rpc-client) | browser-safe typed daemon client over live HTTP and SSE or a static snapshot |
| 1 | [`@titan-design/matrix-bus`](https://hjewkes.github.io/titan-platform/reference/matrix-bus) | Matrix client-server API over `fetch`: appservice client, item codec, `#queue` bootstrap |
| 2 | [`@titan-design/session-read`](https://hjewkes.github.io/titan-platform/reference/session-read) | Claude Code and Codex transcripts parsed into typed session events with locators |
| 2 | [`@titan-design/session-graph`](https://hjewkes.github.io/titan-platform/reference/session-graph) | session events folded into an activity graph on store-sqlite |
| 2 | [`@titan-design/session-analytics`](https://hjewkes.github.io/titan-platform/reference/session-analytics) | pricing, session classification, roles, episodes, and the cost report |
| 2 | [`@titan-design/code-graph`](https://hjewkes.github.io/titan-platform/reference/code-graph) | TypeScript and Python code graph with metrics, checks, findings, and incremental reuse |
| 2 | [`@titan-design/code-read`](https://hjewkes.github.io/titan-platform/reference/code-read) | versioned, browser-safe read API over code-graph snapshots |
| 2 | [`@titan-design/memory`](https://hjewkes.github.io/titan-platform/reference/memory) | decaying rule playbook: bullets, feedback, curation, recall |
| 2 | [`@titan-design/workflow`](https://hjewkes.github.io/titan-platform/reference/workflow) | durable imperative workflows: memoized steps, agent dispatch, fan-out, human gates |
| 2 | [`@titan-design/style-profile`](https://hjewkes.github.io/titan-platform/reference/style-profile) | one code-style profile exported as ESLint, ruff, EditorConfig, and agent rules |
| 2 | [`@titan-design/style-analyzer`](https://hjewkes.github.io/titan-platform/reference/style-analyzer) | tree-sitter style extractors and the aggregator that builds a profile |
| 2 | [`@titan-design/style-checker`](https://hjewkes.github.io/titan-platform/reference/style-checker) | runs ruff, ESLint, and Python audit tools and normalizes their diagnostics |
| 2 | [`@titan-design/queue-mirror`](https://hjewkes.github.io/titan-platform/reference/queue-mirror) | mirrors a local queue of human-actionable items into a Matrix room and folds verdicts back |
| ui | [`@titan-design/react-app`](https://hjewkes.github.io/titan-platform/reference/react-app) | React hooks over rpc-client and a Vite preset for daemon-backed apps |
| ui | `@titan-design/react-ui` | the design system, published from the separate titan-design repository; no library here may import it |
| product | `products/*`, `apps/code-report` | private thin compositions, not published |

`.codewatch/check.json` is the source of truth. Its `package-layers` rule lists every
package by tier, and CI fails any pull request that adds an import against the order.

## Working here

```
pnpm install && pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm dag:check
```

Before adding code:

1. Read [CAPABILITIES.md](CAPABILITIES.md) and the reference page of every unit that looks close.
2. Name the existing unit you reuse, or the gap you fill and its task, in the plan and the PR.
3. Verify runtime and auth assumptions with the path's smoke check before you build on them.

All six must be green before you finish a change. `dag:check` runs the self-hosted check
against this repo's own `@titan-design/code-graph`, built by `pnpm build`.

Adding a package, running the DAG check against a base ref, the changeset requirement, the
release flow, and the docs-site scripts are all documented in
[Working in the repo](https://hjewkes.github.io/titan-platform/guides/contributing).
