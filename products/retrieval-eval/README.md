# @titan-design/retrieval-eval

The eval harness retrieval decisions are judged against. Private; never published.

It answers one question in two shapes. **Shape 1** is the agent-invoked recall tool, which
agents may call and almost never do. **Shape 2** is deterministic retrieval on a trigger:
at agent spawn, with the brief as the query, and at session bootstrap, with the initiative's
open loops as the query. The harness measures shape 2 against labels mined from what agents
actually went on to open, and counts shape 1's uptake directly.

## The caveat that governs every number

**Labels are files the agent went on to read.** They undercount relevance badly, because an
agent reads what it managed to find — a file it never located leaves no trace. A green
recall number means retrieval *would have surfaced what the agent went looking for*. It does
not mean retrieval surfaced everything the agent should have known.

## Commands

```sh
retrieval-eval mine --out pairs.jsonl            # query/label pairs, both arms, to JSONL
retrieval-eval run pairs.jsonl                   # score every candidate and query variant
retrieval-eval run pairs.jsonl --embedder ollama # hybrid over Ollama nomic-embed-text instead of hash
retrieval-eval uptake --since 2026-09-01         # recall-tool calls vs filesystem search
retrieval-eval served --since 2026-09-16         # what rendered blocks served, and whether it was used
```

`mine` writes JSONL to stdout (or `--out`) and a stats-plus-corpus-snapshot block to stderr.
`run` prints a TSV grid, or JSON with `--json`.

## The two arms

**Spawn arm.** Every `agent_spawn` tool call is a query (its `brief`). The labels are the
files the spawned agent then opened with `Read`, `Edit` or `Write`. The documented join —
the `subagent` table in the session graph — is empty, so the link is the brief text itself:
a spawned agent receives its brief verbatim as the first user turn. A brief spawned more
than once is disambiguated by taking the earliest child that starts at or after the spawn.

**Bootstrap arm.** Each session record's `next_steps` ledger is a query. The labels are what
the next canonical session on that initiative opened. Resolving that next record to a
transcript works for a uuid `session_id`, and for a `session_01…` id via the session's own
web url stamped into the transcript. Records whose `session_id` is a hand-written slug
pre-date transcript ids and cannot be resolved at all.

## The served arm

The two arms above ask whether a ranker *would have* surfaced what the agent read. The
`served` arm asks whether what was *actually rendered* got used (design-sources §1.3). One
query unit is one rendered block, read back from the transcript's first user turn that
carries it: active-work's bootstrap `see:` lines under each open loop, or agent-chat's
"## Related to this assignment" list in a spawned agent's brief. Each served ref gets three
labels:

- **opened**: its filename (or task id) appears in any later tool input: `Read`, a Bash
  `cat` or `sed`, a Grep path.
- **cited**: its filename or task id appears in later assistant prose or in the session
  record written at wrap. This catches a note whose title was enough without opening it.
- **opened-section**: reported as `n/a`. Rendered refs carry no span anchor until design B4
  ships, so there is no served line range to match a `Read` offset against.

The control is the unserved base rate: every same-class file in each served initiative that
the block did not serve, run through the same filename test. It is computed for sources and
notes; a task id is a substring of too much to be a fair control. Rows are sliced by trigger
and class, by initiative, by whether the ref was foreign (``[from `slug`]``), and by file.

`--until` closes the window: blocks rendered at or after it are skipped, and so is any later
activity in an earlier session, so a re-run over a closed window gives the same numbers.

## The candidates

| Name | What it is |
| --- | --- |
| `date-order-notes` | The baseline in production today: newest notes by filename date, query ignored |
| `active-work-search` | The shipped per-class RRF search, as a subprocess against the installed binary |
| `notes-fts` | The notes-only span search the bootstrap runs, mirroring `rank-notes.ts` |
| `hybrid-fts-vector` | `notes-fts` fused by RRF with a `HashEmbedder` vector index |

`hybrid-fts-vector` runs with no model and no network by default. `--embedder ollama` swaps
in Ollama's `nomic-embed-text` at `127.0.0.1:11434`; it fails if Ollama is not running.

## Query derivation

A brief is thousands of characters and FTS ORs every token, so which words become the query
is a real decision. Two variants are measured rather than one assumed: `heading-lead` (first
heading plus the opening content words) and `top-df` (the rarest terms by corpus document
frequency).

## Reading the numbers

See [REPORT.md](./REPORT.md) for a run on the real corpus, with the label-set sizes, link
rates, and the corpus snapshot that makes it reproducible.

Everything the harness touches outside this package is read-only, including the session
graph, which it opens with `readonly: true`.
