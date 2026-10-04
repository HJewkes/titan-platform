# Package families

Most packages here are used alongside a few others that share their job. This page groups
them by that job and says which one to open first. Each entry is one line; the reference
page has the detail. [Architecture](/guides/architecture) has the tier rules these
groupings sit inside.

## Storage and provenance

[`store-sqlite`](/reference/store-sqlite) is the base almost everything that persists
builds on: table factories for entities, bi-temporal edges, contentless FTS5, watermarks and
cache blobs, plus forward-only migrations. [`locator`](/reference/locator) points at a byte
range in a source file, so the FTS index never copies text.
[`cluster`](/reference/cluster) and [`embed`](/reference/embed) are the other two
domain-free primitives: Drain template mining and embeddings with a hash fallback.
[`retrieval`](/reference/retrieval) fuses FTS, vector, and graph retrievers over them.
The [retrieval eval](/guides/retrieval-eval) product scores candidate retrievers against
labels mined from transcripts, so a retrieval change can be measured.

## Command surfaces

- [`registry`](/reference/registry): one zod command definition projected to a CLI, an MCP
  tool list, and an HTTP route.
- [`daemon`](/reference/daemon): hosts a registry on a loopback port with `/rpc`, `/mcp`,
  SSE events, a health route, and a pid file.

[Case study: adopting registry and daemon](/guides/adopting-a-package) shows the two
replacing a product's hand-written server.

## The front-end kit

A daemon's web front end, or a static report that needs no daemon, uses three packages.
[`apps/codewatch`](https://github.com/HJewkes/titan-platform/tree/main/apps/codewatch)
composes all three.

- [`rpc-protocol`](/reference/rpc-protocol): the wire contract as dependency-free data and
  types (envelope, exit codes, routes, SSE vocabulary, `CommandMap`). On the server side,
  `registry` re-exports its envelope and exit codes, and `daemon` its SSE message type.
- [`rpc-client`](/reference/rpc-client): a browser-safe typed client over a `DataSource`,
  either `liveSource` against a running daemon or `staticSource` over one snapshot file.
- [`react-app`](/reference/react-app): a provider and hooks typed from the command map, and
  a Vite preset. Components and styling live in the separate design system,
  [`react-ui`](/reference/react-ui), which no package here imports.

## Agent execution

- [`agent-protocol`](/reference/agent-protocol): harness-neutral identity, execution
  phases, and usage types. It launches nothing.
- [`agent-lifecycle`](/reference/agent-lifecycle): a SQLite ledger of execution state with
  fenced ownership, for supervisors that must survive a restart.
- [`agent`](/reference/agent): headless Claude Code and Codex runs with an environment
  scrub, required budgets, a failure taxonomy, and a durable dispatcher.
- [`agent-dispatch`](/reference/agent-dispatch): a client for the `agent-chat` CLI. It starts
  an agent under a named profile with the brief on stdin, resumes an ended session, and reads
  the roster. Use `agent` instead to run one headless turn in process.
- [`hitl`](/reference/hitl): a durable `gate()` that a human resolves from any process.
- [`workflow`](/reference/workflow): an ordinary async function whose `dispatch`, `seed`,
  and `assisted` steps are memoized, with `mapItems` fan-out under a budget.

[Multi-harness contracts](/guides/multi-harness-contracts) covers how the Claude and Codex
paths share these types.

## Session mining

[`session-read`](/reference/session-read) parses Claude Code and Codex transcripts into
typed events with locators. [`session-graph`](/reference/session-graph) folds them into an
incrementally maintained graph. [`session-analytics`](/reference/session-analytics) prices
requests, classifies sessions and roles, cuts episodes, and renders the cost report over
that graph. [`memory`](/reference/memory) keeps a decaying rule playbook that such mining
can feed. [Case study: the session miner](/guides/session-miner) runs the first two end to
end.

## Code audit

- [`code-parser`](/reference/code-parser): tree-sitter WASM parsing for TypeScript, TSX,
  and Python, the source-file filter, and the `Extractor` contract.
- [`code-graph`](/reference/code-graph): the import, reference, and call graph with
  index-time metrics, the `check.json` rules engine, stored findings and verdicts, and git
  history. This repo's own `pnpm dag:check` runs on it.
- [`code-read`](/reference/code-read): a versioned read contract over one snapshot,
  answered by pure functions a daemon and a browser both call.
- [`style-analyzer`](/reference/style-analyzer), [`style-profile`](/reference/style-profile),
  and [`style-checker`](/reference/style-checker): observe a repo's style, hold it as one
  profile exported to ESLint, ruff, and agent rules, then run those tools and the Python
  audit runners and normalize their diagnostics.
- [`evidence`](/reference/evidence): checks that a model's citations name lines it was
  shown and quote them exactly, and scores planted controls.

## Landing a change

These packages decide whether a change may leave the machine and whether a pull request may
merge. The [factory](/guides/factory) product composes `github`, `authority`, `hitl`, and
`workflow` into the land and [Shepherd](/guides/shepherd) workflows.

- [`github`](/reference/github): a GitHub REST port over the caller's `gh` login. Every write
  reads first, so a step that repeats after a crash repeats no effect. `requiredChecks` reads
  the branch rules, `mergeReadiness` decides without I/O, and `fakeGitHub()` stands in for
  tests.
- [`authority`](/reference/authority): the decision table as data, and a pure `evaluate`.
  For each action class and actor class it answers `allow`, `gate`, or `deny`, and it names
  who may resolve a gate. `hitl` takes its resolver classes from it.
- [`fix-proof`](/reference/fix-proof): decides whether a fix pull request's new tests fail on
  the merge base and pass at head. It plans the overlay and classifies two vitest reports; a
  runner does the git and test work.
- [`egress-scan`](/reference/egress-scan): refuses home paths, private-workspace paths, and
  private terms in a diff bound for a public repo. The `titan-egress-scan` bin backs this
  repo's pre-push hook and its CI job.

## Messaging and the human queue

- [`chat-protocol`](/reference/chat-protocol): one message document, the AI SDK `parts[]`
  model plus an envelope, shared by every agent-chat surface.
- [`messaging`](/reference/messaging): a one-method `MessageTransport` with BlueBubbles
  (iMessage) and Telegram adapters, inbound validators, and liveness probes.
- [`matrix-bus`](/reference/matrix-bus): the slice of the Matrix client-server API the
  human queue needs, over `fetch`, with the `io.titan.item` codec and an owner-only
  resolution fold.
- [`queue-mirror`](/reference/queue-mirror): mirrors a local queue of approvals and
  questions, such as pending `hitl` gates, into a Matrix room and folds the owner's
  verdicts back.
