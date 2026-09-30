# Running the retrieval eval

`retrieval-eval` measures whether a retriever would have surfaced the files an agent went on
to open. It mines query and label pairs from Claude Code transcripts with no model in the
loop, scores candidate retrievers on them, and reports recall, precision, MRR and the
characters each candidate would inject. Run it before and after a retrieval change.

The [retrieval-eval reference](/reference/retrieval-eval) explains the method. Read its
caveat first: a label is a file the agent read, so every recall number is a floor.

## Prerequisites

- Node 20 or newer and pnpm 9.
- Claude Code transcripts under `~/.claude/projects`. The harness also reads
  `~/.claude-profiles/*/projects` when that directory exists. These roots are fixed; there
  is no flag for them (`products/retrieval-eval/src/corpus/transcripts.ts`).
- An active-work data directory. The default is the macOS location under your home
  `Library` folder, which `retrieval-eval mine --help` prints; pass `--active-root`
  elsewhere.
- A session graph at `<active-root>/.miner/graph.sqlite3`, or `--graph <file>`. The harness
  opens it read-only.
- The `active-work` binary on `PATH`, only for the `active-work-search` candidate.
- Ollama on `127.0.0.1:11434`, only for `--embedder ollama`.

Everything the harness touches outside its own output is read-only.

## Build

```sh
pnpm install --frozen-lockfile && pnpm build
node products/retrieval-eval/dist/bin.js --help
```

The examples write `retrieval-eval` for `node products/retrieval-eval/dist/bin.js`.

## Commands

### `mine`

```sh
retrieval-eval mine --out pairs.jsonl
retrieval-eval mine --arm spawn --active-root /srv/active-work > spawn-pairs.jsonl
```

Writes one JSON object per pair to `--out`, or to stdout. It prints the per-arm statistics
and a corpus snapshot to stderr, so a redirect of stdout stays clean JSONL. `--arm` is
`spawn`, `bootstrap` or `both` (the default).

- **Spawn arm.** Each `agent_spawn` tool call is a query (its brief). The labels are the
  files the spawned agent then opened.
- **Bootstrap arm.** Each session record's `next_steps` is a query. The labels are what the
  next session on that initiative opened.

### `run`

```sh
retrieval-eval run pairs.jsonl
retrieval-eval run pairs.jsonl --candidates date-order-notes,notes-fts --variants top-df
retrieval-eval run pairs.jsonl --embedder ollama --json
```

Scores every candidate and query variant over the pair file. It prints progress to stderr
and a tab-separated table to stdout, or JSON rows with `--json`:

```
arm	scope	candidate	variant	pairs	R@5	P@5	R@10	P@10	MRR	chars@5	err
```

| Option | Values | Default |
| --- | --- | --- |
| `--candidates` | `date-order-notes`, `active-work-search`, `notes-fts`, `hybrid-fts-vector` | all four |
| `--variants` | `heading-lead`, `top-df` | both |
| `--embedder` | `hash`, `ollama` | `hash`: no model and no network |
| `--active-root`, `--graph` | paths | see prerequisites |

`date-order-notes` is the baseline: the newest notes by date, with the query ignored.
Compare every other row to it, not to zero. `chars@5` is not comparable across candidates.

### `uptake`

```sh
retrieval-eval uptake --since 2026-09-01
```

Counts calls to a recall tool against filesystem-search calls across the transcripts, and
prints JSON. `--since` ignores tool calls before that date.

### `served`

```sh
retrieval-eval served --since 2026-09-16 --until 2026-09-23
retrieval-eval served --files 50 --json
```

Labels what rendered bootstrap and spawn blocks actually served. Each served reference is
marked `opened` or `cited`, and the report gives the unserved base rate as a control.
`--until` closes the window, so a rerun over a closed window gives the same numbers.
`--files` sets the rows in the per-file table (default 20).

## Where output goes

The harness keeps no state. `mine` writes the pair file you name; every other command
prints to stdout. A recorded run on a real corpus, with its snapshot, is in
[`REPORT.md`](https://github.com/HJewkes/titan-platform/blob/main/products/retrieval-eval/REPORT.md).
Pair files hold briefs and file paths from your own sessions. Do not commit them to a
public repo.

## How it fails

Every error prints one line to stderr and exits 1.

| What you see | Why |
| --- | --- |
| `ENOENT: no such file or directory, open '…'` | `run` was given a pair file that does not exist |
| `unable to open database file` | the session graph path is wrong; pass `--graph` |
| `--embedder must be hash or ollama, got …` | an unknown embedder |
| a connection error with `--embedder ollama` | Ollama is not running |
| a header row and no data rows | the pair file is empty; `mine` found nothing to label |
| zeros in an `active-work-search` row | the subprocess answered with no parseable hits; a malformed answer scores as empty instead of stopping the run |
| a count in the `err` column | that many queries threw for that candidate; the rest were still scored |
