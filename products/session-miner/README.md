# @titan-design/session-miner

The first product on the platform: index every Claude Code transcript into a session
graph, search it, cluster its recurring failures, and serve all of that over a CLI, MCP,
and HTTP from one command registry. It exists as much to prove the package DAG end to
end as to be useful.

Private (not published). Composes `registry`, `daemon`, `store-sqlite`, `locator`,
`cluster`, `session-read`, `session-graph`, `retrieval`, `embed` (TP-7), and `memory`
(TP-19).

```
titan-miner refresh            # index new transcript bytes (--full rebuilds from zero); also reconciles the graph's price rows with session-analytics' PRICE_TABLE
titan-miner status             # counts, transcript states, FTS orphan ratio
titan-miner search "daemon 503 at startup"
titan-miner session list -n 20
titan-miner session show <session-id>
titan-miner drain ingest       # cluster tool errors into templates
titan-miner drain templates
titan-miner playbook add "Pin npm to 11 in release jobs" --tag ci --tag release
titan-miner playbook recall "release job npm"
titan-miner playbook reflect <session-id>   # renders the diary; applies nothing
titan-miner playbook status
titan-miner memory scan        # count auto-memory fact files by account and type
titan-miner memory report      # dedupe and group them, write report.md and decisions.yml for review
titan-miner insights spend-by-action --since 2026-09-01 --role coordinator
titan-miner serve --port 7400  # /rpc, /mcp, /events on loopback
titan-miner mcp                # MCP over stdio
titan-miner --graph <file> graph-refresh -- <owner refresh...>   # scheduled refresh; see below
titan-miner --graph <file> tool-gap-weekly --notify-command <path>  # weekly tool-gap pass; see below
```

Every command takes `--json` for the envelope. `--state <dir>` and `--corpus <dir>` (or
`TITAN_MINER_STATE` / `TITAN_MINER_CORPUS`) override the defaults of
`~/.local/state/titan-session-miner` and `~/.claude/projects`.

The package is private, so `titan-miner` is not on your `PATH` after a global install.
Run it from a built checkout with `pnpm --filter @titan-design/session-miner exec titan-miner <args>`
or `node products/session-miner/dist/bin.js <args>`.

`--graph <file>` (or `TITAN_MINER_GRAPH`) reads a session graph another owner writes,
such as active-work's `.miner/graph.sqlite3`, in place of the miner's own index. The
miner opens it read-only: it runs no migrations, writes no price rows, and refuses write
commands. Opening refuses a graph that lacks any session-graph migration this runtime
declares.

A foreign graph holds session-graph's tables but none of the miner's own, so only the
commands that read session-graph tables work on it:

- Work: `status` (reports `templates: 0`), `session list`, `session show`, `search`,
  and the `insights` questions.
- Refused with exit 65 and a message naming the foreign graph: `drain ingest`,
  `drain templates`, and every `playbook` command (`add`, `recall`, `reflect`, `status`).
  Drain templates and the playbook live only in the miner's own index.

```
titan-miner --graph "<active-work root>/.miner/graph.sqlite3" insights spend-by-action
```

The miner's own migrations are numbered from 2000. Session-graph owns the low numbers
and active-work's band starts at 1001, which is where the miner's band sat before.

## How the tiers compose

- `session-read` discovers transcripts (including subagent sidechains) and turns lines
  into events with byte-offset locators.
- `session-graph` folds them into kit tables (`store-sqlite`) and keeps the index current
  from per-transcript watermarks.
- `search` runs a `retrieval` engine: contentless FTS over the spans plus one hop of
  graph expansion through the edge table, fused with RRF, with a locator on every hit that
  `locator` reads back into an excerpt. Nothing in the index stores transcript text.
- `drain ingest` reads each unclustered `tool_result_error` fact through its locator,
  screens it with `hasErrorSignal`, and clusters it with `cluster`'s Drain pipeline. The
  clusterer snapshot lives in the same database so ids survive restarts.
- `registry` defines each command once; the CLI (commander), `daemon` (`/rpc`, `/mcp`,
  `/events`), and MCP stdio are projections of the same registry.
- `playbook` is `memory` over the same database: rules with decaying confidence, curated
  deterministically. See below.

## Insights (TP-507)

`titan-miner insights <question>` answers one cost question from the graph. Each question
is a pure function in `@titan-design/session-analytics`; the miner only registers it, so
it runs on the CLI, as the MCP tool `miner__insights__<question>`, and at
`POST /rpc/insights.<question>`.

| Question | Command | Answers | Own options |
| --- | --- | --- | --- |
| Q0 | `insights prices` | the price table as data, the models in the window no row prices, and every model in a published price file the table prices differently or not at all; no cost claim until that list is empty | `--published <file>` (CLI only): JSON `[{ model, input, cacheRead, cacheWrite5m, cacheWrite1h, output }]` in USD per million tokens |
| Q1 | `insights spend-by-action` | each role's spend by turn action, and the mechanical share | `--mechanical <class>` |
| Q2 | `insights handoff-threshold` | boot cost, fill growth and the best handoff threshold K per role | `--k <tokens>`, `--reviewer-prs <n>`, `--broker-log <path>` (CLI only) |
| Q3 | `insights cache-ttl` | what a 5-minute cache TTL would save against 1h, per role and profile | none |
| Q4 | `insights wake-economics` | what wakes a coordinator, and the requests and cost per wake episode | `--episode-role <role>` |
| Q5 | `insights tool-errors` | error tool results and classifier denials per local day, by error class and by tool, with sessions and agents, and denials by classifier reason | `--transcript <seat>=<path>` (CLI only) |
| Q6 | `insights round-trips` | per local day, a parent's follow-ups to the agents it spawned by class (`brief-fix`, `poll`, `correction`, `other`), and per PR the verdict sequence with FIX_FIRST rounds and re-reviews, plus verdicts with no PR line | none |
| Q7 | `insights blocked-flow` | per repo: verdict-to-merge minutes, open PRs holding MERGE, classifier denials, idle implementer slots | `--seat <seat>`, `--split-at <time>`, `--transcript <seat>=<path>`, `--journal <seat>=<path>`, `--pulls <file>` (last three CLI only) |
| Q8 | `insights liveness` | seats dark over 5 min with and without a teleport, routes that missed a recipient, unreported exits by profile, agents whose last event is a permission prompt over 10 min old | `--seat <name>`, `--broker-log <file>` (CLI only) |
| Q9 | `insights tool-gaps` | post-filters agents pipe after our CLIs, grouped by normalised pattern, each marked NEW or EXISTS-UNUSED against the CLI's `--help` | `--top <n>` |
| Q10 | `insights tool-adoption` | per flag or verb in the adoption registry, weekly uses of the new form against the old pipelines it replaces, flagged unadopted or unused two weeks after ship; an unshipped baseline counts the old pipelines alone | none |
| Q11 | `insights probes` | one row per probe per local day: a named Q5 or Q6 measure against its target, HOLDING, REGRESSED or NO-DATA | `--probes <file>` (required, CLI only) |
| Q12 | `insights data-quality` | faults to clear before any analysis, one row each with severity, evidence and a suggested task title: graph stale, transcripts discovered but not indexed, facet backlog, unpriced models, and with `--assignments` bad lines, unknown outcomes and agents with no session | `--max-lag <minutes>` (default 60), `--assignments <file>` (CLI only), `--known-outcome <word>` |
| Q13 | `insights quality-guardrails` | review verdicts by the reviewer's context fill with changes-requested and verdict-error rates, and successor rework per role; with a before window, each row before and after with its change, after minus before | `--before-since <time>` and `--before-until <time>` (both or neither), `--boot-requests <n>` (default 30) |
| Q14 | `insights seat-generations` | each agent that held a seat's name in the window, in start order, with its start, end, how it ended (`handoff`, `teleport`, `exit` or `open`) and its graph sessions, plus a ready `--session` argument string for the graph questions | `--seat <name>` (required), `--broker-log <file>` (CLI only) |

Every question takes the same filters, which combine with AND: `--session <id>` and
`--role <role>` (both repeatable), `--agent-prefix <prefix>` for agent-chat names, and
`--since` (inclusive) and `--until` (exclusive) on request time. Roles are the cost
report's `byRole` names, such as `coordinator` or `worker:reviewer`. Compactions and
coverage stay window-wide. Dates must parse and are compared in UTC, so an offset timestamp
works. MCP and HTTP refuse an unknown key, and refuse `brokerLog` and `published` because they read a local file.

With `--json` the envelope's data is `{ question, caveat, filters, answer }`, where
`answer` matches the question's zod schema. Without it the question prints its text
renderer. Both carry `LIST_PRICE_CAVEAT`: the figures are list prices, not a bill.

Q12 runs first. The graph is stale when its newest request trails `--until` (or now) by more
than `--max-lag` minutes. An `error` fault means the numbers it touches are wrong and no claim
should rest on them; a `warn` fault means they are incomplete. `--assignments` takes JSONL in
session-analytics' `assignmentSchema` shape: a line that fails the schema is counted, not thrown;
an outcome outside `merged`, `done` and any `--known-outcome` is flagged; and agents the
cost-per-outcome join cannot find in the graph are listed. The code only reports; the
session-insights skill files the tasks.

Q7 reads outside the graph, so it refuses `--session`, `--agent-prefix` and `--role`; narrow it
with `--seat`. Reviewer verdicts come from agent-chat's events table, opened read-only at
`TITAN_MINER_EVENTS_DB` (default `~/.agent-chat/events.db`). `merged_at` and the current head come
from `gh api repos/<repo>/pulls/<n>`, or from a `--pulls` snapshot. Classifier denials come from each
`--transcript` (a `.jsonl` file or a directory of them), and idle slots from each `--journal` named
`<YYYY-MM-DD>.md`, read in this machine's local time. Waits are measured to `--until`, or to now, so a
PR merged later counts as open, and its age is a censored wait. Every table names the JSON field its
numbers come from, and the text ends with the command and field behind each source.

Q8 also reads outside the graph and takes `--seat` in place of the session filters. It reads
agent-chat's broker log at `TITAN_MINER_BROKER_LOG` (default `~/.agent-chat/broker.log`) or
`--broker-log`, and the events table read-only. A seat is dark from a `deregistered` line to its next
`registered` line. A gap with an `agent_exited` line of code 0, not inferred, and no teleport is a clean exit and later
resume, not a dark seat. A gap still open at `--until` is listed only if a route missed the seat during
it. A `delivered:false` route counts as failed, except one the broker held for a dark seat (`held`) or
an answer or decision queued in the inbox, which counts as queued. A name left out of `recipients`
counts as a partial delivery. Broadcasts and tag sends (`to: "tag <name>"`) are skipped. Unreported exits take their profile from the `agent_spawned`
row with the same agent id. A stale prompt is an `approval_request` that is its actor's newest event
before `--until`, not counting `resolution` rows, however long before `--since`; prompts with a `resolution` row are listed apart.
A prompt is skipped once its actor has an `agent_exited` or `agent_retired` row, or when the broker
restarted after it and the actor never registered again. Each row cites its `broker.log:<line>` or `events#<id>`. Q8 is registered from
`AGENT_CHAT_QUESTIONS`, because the shared tests run every other question against the graph.

Q13 runs session-analytics' `reviewFillReport` and `successorReworkReport` over the window. With
`--before-since` and `--before-until` it runs both again over the before window through
`compareWindows`, and `comparison` pairs the rows by key with per-field deltas; it is null without
them. A before window with one bound is a usage error, since it would compare against all history.
Successor rework deltas are null when the graph holds no `file_read` signal. It refuses the session
filters, because neither report is scoped by session. Q13 is registered from `GUARDRAIL_QUESTIONS`.

Q14 resolves a seat to its generations through session-analytics' `seatGenerations`. It reads
`agent_handoff` rows from the events table and spawn, exit and `teleport_completed` lines from the
broker log, and maps each agent id to its graph sessions. It refuses the session filters; name the
seat with `--seat`. A generation that ended before `--since` or started at or after `--until` is
left out, and one with no graph session stays listed with no sessions. `sessionArgs` joins only
the sessions the graph knows; appended to any graph question, it runs that question over a seat
since a time. Q14 is registered from `AGENT_CHAT_QUESTIONS`.

Q9 reads each Bash call in the window back from its transcript, since the graph keeps no command
text; a call whose `command_heads` signal names none of our CLIs is never read. It keeps every
pipeline whose head is `active-work`, `agent-chat`, `titan-factory`, `basement-suite`, `gh`, or
`sqlite3` on one of our databases (also behind `ssh <host>`), and groups them by head and by the pipe
tail normalised to programs and flag names, such as `| grep -E | head` or `| python3 -c json`.
Each pattern's `patternId` is `pf-` plus 12 hex characters of the tail's SHA-256, so it is stable
across runs; `postFilters` and `patternId` are exported for later questions. A pattern is
EXISTS-UNUSED when `<head> --help` names a flag that does a stage's job (`--limit` for `head`,
`--jq` or `--fields` for `jq`, `--prefix` or `--state` for `grep`, and so on) that not every call
already passes, NEW when it names none, and UNKNOWN when the help cannot be run. Output is the tool
result characters of the calls. It refuses `--role`. Q9 is registered from `TRANSCRIPT_QUESTIONS`,
and its tests inject the transcript reader and the help runner.

Q10 tracks the flags and verbs listed in `src/insights/adoption-registry.ts`, seeded with the 15
ranked rows of `bash-to-tool-mining-2026-10-08.md` (each entry carries its `row`). A shipped entry
names the task and merged PR, the merge time, the old head with the Q9 patterns the new form
replaces, and the new head with the flags of which any one marks the new form (none when the verb
itself is new; a flagless new form on the old head is never counted). A `baseline` entry has not
shipped: its task is null until one is filed, it counts the old patterns alone from the window
start, is never flagged, and shows `baseline` in the flags column, so it has its "before" numbers on
the day it ships. A `note` says what Q10 cannot see, such as an MCP argument or a guard denial. It
reads Bash calls back like Q9, from `--since` or else the earliest ship (four weeks back when
nothing has shipped), and counts a pipeline as the
new form when it passes one of those flags, piped on or not, and as the old one when its normalised
tail is one of the patterns. Uses before an entry's ship are ignored. Rows give weekly new/old counts
from ship to `--until` (or now), and the old patterns with their Q9 `patternId`. Two weeks after
ship an entry is flagged `unadopted` while the old patterns outnumber the new form in the uses since
then, and `unused` while nobody ran the new form; before that it is `watching`. It refuses `--role`.
To track a new opportunity, add a baseline entry with the patterns Q9 reported for it, and make it
`shipped` with the PR and merge time when it lands.

Q5 reads each error tool result in the window (an `inbound` row of cause `tool_result` with
`is_error`) back from its transcript, since the graph keeps no result text, and gives it the first
matching class of the self-improve extractor: `classifier-denial`, `permission-denied`,
`user-rejected`, `sleep-block`, `wrong-tool-name`, `hook-block`, `edit-not-read`, `edit-no-match`,
`file-missing`, `gh-graphql-ratelimit`, `gh-secondary-ratelimit`, `gh-other`, `git-error`, `timeout`,
`mcp-tool-error`, `agent-chat-refused`, `test-fail`, `lint-type`, `exit-code`, else `other`; a result
whose line is gone is `unreadable`. Rows are per local day (this machine's clock) by class and by
tool, an MCP tool named by its last segment, with distinct sessions and agent-chat names. Classifier
denials are also counted by their bracketed reason. Each `--transcript` adds the denials it holds
that the graph has not already counted under the same `tool_use_id`, with the seat as the agent; it
cannot be combined with `--session` or `--agent-prefix`. Q5 refuses `--role`.

Q6 reads agent-chat's events table read-only, like Q7, and refuses `--session`, `--agent-prefix`
and `--role`. A follow-up is a message in the window from an agent to one it spawned (the
`agent_spawned` row, however long before `--since`). Its first 1500 characters are classed by the
first match of `brief-fix` (a brief update, correction or "you missed"), `poll` (a status ask) and
`correction` (the self-improve correction phrases), else `other`. Verdicts are messages with a
`Verdict: <WORD>` line, grouped by their `PR:` line, `owner/repo#n` or a pull URL; a verdict
without one is counted on its day only. Each PR lists its verdicts in order: FIX_FIRST rounds are
the verdicts that are not MERGE, re-reviews every verdict after the first, and a first-pass merge a
PR whose first verdict in the window is MERGE. Q6 is registered from `AGENT_CHAT_QUESTIONS`.

Q11 reads its probes from `--probes`, a JSON array of `{ id, task, measure, target, op, since? }`
where `op` is `<=` or `>=` and `since` a `YYYY-MM-DD` the probe starts on. A probe is data: add one
per landed fix, naming its task and target, and keep the file outside this repo. The measures are
`sleep_blocks`, `graphql_ratelimit_errors` and `wrong_tool_name` (Q5 counts of `sleep-block`,
`gh-graphql-ratelimit` and `wrong-tool-name`), `classifier_merge_denials` (Q5 denials whose reason
is "Merge Without Review"), `verdict_without_pr_line_share` and `first_pass_merge_rate` (from Q6,
the latter only on a day with at least 5 first verdicts). A file naming any other measure, or not
matching that shape, is a usage error (exit 64). A count is 0 on a day the graph has a request but
no matching error, and a day a measure has no data for is NO-DATA. Q11 computes only the questions
its probes name and refuses `--session`, `--agent-prefix` and `--role`.

To add a question, write its analysis in `session-analytics` first: a pure function over
the graph, a zod schema, a text renderer that ends with `LIST_PRICE_CAVEAT`, and a
synthetic-fixture test. Then add one `defineInsight({...})` to
`src/insights/questions.ts` with the plan's id, the subcommand name, the question's own
options and flags, the schema, and an `answer` that calls the analysis and its renderer.
Append it to `INSIGHT_QUESTIONS`. The shared tests then cover its envelope, its caveat,
every filter, and its presence on all three surfaces.

### Verifying findings (TP-499)

An analyst reading these answers writes each finding as `findingSchema` (exported from
`src/insights/citations.ts`): `{ id, claim, citations, falsifier }`. A finding with no citation
or an empty `falsifier` fails the schema. Each citation is
`{ question, args, field, value, tolerance? }`: `question` is an insight name such as
`spend-by-action`, `args` its flags as an object (`--agent-prefix`, `agent-prefix` and
`agentPrefix` are the same key), and `field` a JSON pointer into the answer, such as
`/totals/sessions`.

```json
[{ "id": "F1", "claim": "reviewers ran one session", "falsifier": "a second reviewer session in the window",
   "citations": [{ "question": "spend-by-action", "args": { "since": "2026-09-10", "agent-prefix": "rev-" },
                   "field": "/totals/sessions", "value": 1 }] }]
```

`titan-miner insights verify-citations --findings <file>` re-runs each cited question once per
distinct question and args, and gives every citation a status: `ok`, `mismatch` (with the
`actual` value), `missing-field`, `unknown-question`, or `error` (the run failed, such as invalid
args or a missing events db). A number matches within `tolerance` relative to the cited value,
0.01 by default; strings, booleans and null match exactly. It exits non-zero and lists the
failures when any citation is not ok. `--findings` is accepted only on the CLI.

### The session-insights skill (TP-499)

`skills/session-insights/` ships in the package. `SKILL.md` runs the insight loop in order:
resolve the scope (Q14 for a seat since a time), clear Q12 data-quality faults (stopping on a
stale graph), check prices with Q0 `--published` (stopping on any mismatch), run the questions
as JSON, hand the JSON to a read-only analyst with `analyst-brief.md`, keep only the findings
`verify-citations` passes, and file a task for any number the library cannot answer. A seat
loads it from the installed package's `skills/session-insights/` or from a checkout.
Step 2 also flags a file input written before `--until`, and step 7 scores each proposed lever on
Q7's verdict-to-merge and open MERGE PRs (`--split-at`) and on `requestsPerFinished`.
Each lever names Q13 `quality-guardrails` with `--before-since` and `--before-until` as its
guardrail, so a proposal shows whether the lever cost review quality or successor rework.
`src/session-insights-skill.test.ts` fails when the skill names an unregistered question, when
the data-quality or price step moves after the questions, when step 7 drops a lever metric or
the Q13 guardrail, when
the brief's example stops parsing as `findingSchema` or still parses without its falsifier, or
when the brief names an agent-chat command or tool.

## The playbook (TP-19)

`playbook add` is the default path and costs nothing: the agent that just learned
something writes it down, and `memory`'s curator folds restatements into feedback rather
than accumulating near-duplicates. `playbook recall` ranks by relevance times confidence.

`playbook reflect <session-id>` is the deterministic half of the AW-31 design. It builds a
diary out of the session's own subgraph, never a model: title, branch, turns, files
touched, tasks and their status, linked pull requests, subagents, and the recurring error
signatures Drain already clustered. The outcome label is derived the same way, from merged
versus abandoned pull requests, task status, and error counts, so the training signal is
graph-derived rather than self-reported. Note that the task half is inert today: the graph
mints task refs but never resolves their status, so on the real corpus only the pull
request and error signals move the label (TP-20). By default it renders the diary and
applies nothing; supply a `Reflector` on the context to let a model propose deltas, which
are then zod-validated and stamped with `{ sessionRef, byteOffset }` provenance by the
curator rather than by the model.

The playbook is strictly downstream. It reads the graph and never writes back, so the
index stays valid with the playbook ignored, and a test asserts the row counts do not move.

## Auto-memory review (TP-604)

Claude Code writes auto-memory facts to `<config dir>/projects/<project>/memory/*.md`,
indexed by a `MEMORY.md` beside them. These commands give the owner a view of all of it.

- `memory scan` reads every memory directory under the roots `claudeTranscriptRoots()`
  finds (`~/.claude`, each `~/.claude-profiles/<name>`, or `CLAUDE_CONFIG_DIRS`, plus
  mirror roots). It returns counts by account and type, plus the files it could not parse.
  A symlinked memory directory is skipped.
- `memory report` runs the scan, then `@titan-design/memory`'s `dedupeFacts`, `groupFacts`
  and `proposeDestination` against the skills under `--skills-root` (repeatable; default
  `~/.claude/skills`). It writes `report.md` and `decisions.yml` to
  `<state>/memory-miner/<reportId>/`, or under `--out`. The directory is mode 0700 and the
  files are 0600, because memory bodies can hold anything. Every group starts as
  `decision: pending`, with an editable `destination`, a `reason`, and each source's path
  and content hash. The `reportId` is the UTC time plus a digest of the facts' content
  hashes.

The envelope carries paths and counts (groups, singletons, largest group, groups per
destination), never fact text, so MCP and HTTP callers see no memory bodies.
`--skills-root` and `--out` are accepted only on the CLI. Neither command opens the graph.

`--group-threshold` (default 0.03, from `@titan-design/memory`) is the average topic
similarity, a TF-IDF cosine, at which two groups merge. Grouping is average-linkage with a cap
of 25 facts per group, so it does not chain unrelated facts together. A higher value gives more
and smaller groups. On 2026-10-11 the default gave 51 groups, the largest of 22, on 303 real
facts.

`memory apply`, which acts on accepted groups, is the next slice.

## Not yet here

A dashboard (waits on TP-10's UI split), vector search over the spans (the `embed`
dependency is wired but no vector index is built yet), per-tool partitions for Drain (the
fact table does not carry tool names for results yet).

The playbook has no semantic recall yet: `memory` supports a vector index, but the miner
does not build one, so recall is keyword-only.


## Scheduled refresh (TP-2073)

`titan-miner graph-refresh -- <command...>` is one scheduled pass over a graph. It is built
for a graph another owner writes, such as active-work's, so it indexes nothing itself: it
runs that owner's incremental refresh and then proves the file is whole.

1. It takes `--lock <file>` (default `<state>/graph-refresh.lock`) without waiting. If
   another live run holds it, it logs the holder's pid and exits 75. A lock whose pid is
   gone was left by a killed run and is taken over.
2. It runs the command with inherited stdio. The command must write the graph only inside
   SQLite transactions, which both active-work's and the miner's own `refresh` do, so a pass
   killed mid-write rolls back and the rows from before it stay.
3. It opens the graph read-only and runs `PRAGMA quick_check`, then logs the session count
   and the newest session's start time. The open is plain SQLite, so an owner's graph at an
   older session-graph migration is still checked.

Every failure is one stderr line starting `graph-refresh: FAILED:`, and the exit code is 70.
Stdout carries one JSON line: `outcome` (`ok`, `locked`, `refresh-failed` or `corrupt`),
`health` and `exitCode`.

`ops/systemd/session-miner-refresh.{service,timer}` run it hourly on a Linux host over
active-work's graph, with `active-work miner refresh` as the command. That command walks
every Claude config dir (`~/.claude/projects` and `~/.claude-profiles/*/projects`) and
skips a transcript whose watermark is current; it shares active-work's own refresh lock with
the active-work daemon, so the two never write at once. The units assume this checkout at
`~/projects/titan-platform`, built, and `active-work` in `~/.local/bin`. The service reads
`ACTIVE_ROOT` and `TITAN_MINER_GRAPH` from `~/.config/titan-session-miner/refresh.env`, which
it requires, so a host without that file fails instead of checking the wrong graph. To install
(an owner step), with `<root>` for the active-work root:

```sh
pnpm -C ~/projects/titan-platform --filter @titan-design/session-miner... build
mkdir -p ~/.config/titan-session-miner
printf 'ACTIVE_ROOT=<root>\nTITAN_MINER_GRAPH=<root>/.miner/graph.sqlite3\n' > ~/.config/titan-session-miner/refresh.env
install -m 644 -t ~/.config/systemd/user ~/projects/titan-platform/ops/systemd/session-miner-refresh.service ~/projects/titan-platform/ops/systemd/session-miner-refresh.timer
systemctl --user daemon-reload
systemctl --user enable --now session-miner-refresh.timer
```

Then `systemctl --user start session-miner-refresh.service` runs a pass at once,
`journalctl --user -u session-miner-refresh` shows its log, and a failed pass leaves the
unit in `systemctl --user --failed`.

## Weekly tool-gap pass (TP-2076)

`titan-miner tool-gap-weekly --notify-command <path>` is one weekly pass over Q9
`tool-gaps` and Q10 `tool-adoption`. It files and notes tasks and reports; it never builds a tool.

1. It takes `<state>/tool-gap-weekly/run.lock` without waiting; a second live run exits 75.
2. It runs both questions over the 7 days ending now and diffs them against
   `<state>/tool-gap-weekly/latest.json`, last week's answers. A first run counts every row as new.
3. For each pattern id with at least `--min-calls` calls (default 50) and `--min-sessions`
   sessions (default 10) that the adoption registry does not already name, it files one task in
   `--initiative <slug>` (default `titan-platform`) through `active-work task add`, tagged
   `tool-gap`, `tool-gap:<patternId>` and `item-114`. If an open task already carries
   `tool-gap:<patternId>`, it appends this week's counts with `active-work task note` instead.
4. It runs the notify command once, with the digest on stdin: new gaps, task actions, adoption
   results and removal candidates (shipped, unused 28 days or more after ship). The digest is a
   notice and asks nothing.
5. Only then does it replace `latest.json`. If a task action or the notifier fails, the pass logs
   `tool-gap-weekly: FAILED: …`, exits 70 and keeps last week's snapshot, so the next run diffs
   against the same base. A rerun in the same week notes the tasks the failed run did file.

Stdout carries one JSON line: `outcome` (`ok`, `locked` or `failed`), the actions taken, and
`exitCode`. agent-chat has no CLI verb that posts a notice, so the operator picks the notifier:
any executable that reads stdin.

`ops/systemd/session-miner-tool-gaps.{service,timer}` run it every Monday at 05:30, catching up a
missed week on boot. The service reads `ACTIVE_ROOT`, `TITAN_MINER_GRAPH` and `TITAN_MINER_NOTIFY`
from `~/.config/titan-session-miner/tool-gaps.env`, which it requires. To install (an owner step,
same build and checkout as the hourly refresh):

```sh
printf 'ACTIVE_ROOT=<root>\nTITAN_MINER_GRAPH=<root>/.miner/graph.sqlite3\nTITAN_MINER_NOTIFY=<notifier>\n' > ~/.config/titan-session-miner/tool-gaps.env
install -m 644 -t ~/.config/systemd/user ~/projects/titan-platform/ops/systemd/session-miner-tool-gaps.service ~/projects/titan-platform/ops/systemd/session-miner-tool-gaps.timer
systemctl --user daemon-reload
systemctl --user enable --now session-miner-tool-gaps.timer
```

## Throughput (TP-2155)

`titan-miner throughput table` fits `@titan-design/throughput`'s class table (kind x size band)
over done tasks; `titan-miner throughput backtest` scores it at rolling origins. Both read done
task YAML from `<TITAN_MINER_INITIATIVES_ROOT>/<initiative>/tasks/*.yml` (the root defaults to
active-work's data root) for the initiatives in `TITAN_MINER_THROUGHPUT_INITIATIVES`, a comma
list that defaults to the engineering initiatives. A task's kind comes from its `kind:<x>` tag.
Files that fail pm's `TaskSchema` are counted as `unparsed`, not fatal.

Task-linked sessions live in active-work's graph, so pass it. The graph is always opened
read-only, the miner's own index included:

```sh
titan-miner --graph "<active-work root>/.miner/graph.sqlite3" throughput table
titan-miner --graph "<active-work root>/.miner/graph.sqlite3" throughput backtest --weeks 4 --horizon 7
```

Output leads with the model hash and the watermark (miner `lastIndexedAt`, newest done task).
`--json` returns the full class table or back-test result beside the same header fields.

`titan-miner throughput pr-backfill` (TP-2162) caches each merged PR's head sha and changed
files (paths and line counts, never diff text) in `<state>/pr-diffs.json`, mode 0600, through
the shell's `gh` login. Cached refs are skipped, a 404 is cached as missing, and the run stops
at `@titan-design/github`'s rate floor with its progress saved, so re-run it after the reset.
`--dry-run` counts uncached PRs per repo without calling GitHub; `--since` and `--limit` narrow
a run. It is CLI-only.

```sh
titan-miner --graph "<active-work root>/.miner/graph.sqlite3" throughput pr-backfill --dry-run
```

## Codex sessions

Opt in with `--codex-home ~/.codex --namespace workstation-account` (or
`TITAN_MINER_CODEX_HOME` and `TITAN_MINER_NAMESPACE`). Existing `--corpus` remains the
Claude projects root. Choose a stable host/account namespace; moving a source must
not rename its conversation.

Refresh discovers active and archived Codex rollouts. Session list/show report the
harness and native ID; Codex session IDs are canonical `conversation:` refs. Search
and Drain use the shared format-aware resolver, including semantic subrecords, and
return unavailable excerpts when indexed source bytes have changed or disappeared.
Tool errors with no explicit native error flag are screened by the existing error
signal classifier; they are not classified as permission denials.

The initial normalized ingest replays changed files for correct model context,
projection deduplication and usage accounting. Execution stdout is not a second
transcript corpus. Back up existing graph databases before upgrading; migration is
additive and preserves historical rows even when their originals have been pruned.
