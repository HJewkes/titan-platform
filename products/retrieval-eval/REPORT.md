# Retrieval eval, run on the real corpus

TP-84. Run 2026-09-15 on this machine's transcripts and live workspace index. Every number
below is reproducible from the snapshot in [Corpus](#corpus) with the three commands in
[README.md](./README.md).

## The caveat, first

**Labels are files the agent went on to read.** An agent reads what it managed to find, so a
relevant file it never located leaves no trace and is counted as irrelevant. Every recall
number here is therefore a floor, and it answers a narrow question:

> would retrieval have surfaced what the agent went looking for?

It does not answer "would retrieval have surfaced everything the agent should have known".
Compare candidates to each other and to the `date-order-notes` baseline; do not read an
absolute number as a percentage of relevance.

No LLM appears anywhere in the label path or the scoring path.

## Label sets

| Arm | Pairs | Labels | Labels/pair (median) | Query chars (median) | Initiatives |
| --- | ---: | ---: | ---: | ---: | ---: |
| spawn | 608 | 7,355 | 10 | 3,565 | 13 |
| bootstrap | 35 | 3,427 | 31 | 1,004 | 9 |

### Link rate

| Arm | Considered | Linked | Rate | How |
| --- | ---: | ---: | ---: | --- |
| spawn | 662 spawns | 647 | **97.7%** | 606 brief-text, 41 brief-text + timestamp |
| bootstrap | 125 transitions | 35 | **28.0%** | 22 session-id, 13 harness-id |

608 of the 647 linked spawns became pairs; the other 39 linked to a child that opened no
file at all.

**The documented spawn join does not exist.** TP-84 named the `subagent` table in
`~/Library/Application Support/active-work/.miner/graph.sqlite3` as route (a).
`SELECT count(*) FROM subagent` returns **0**. Nothing populates it, so `agent_ref`,
`session_id` and `child_session_id` link nothing. The link used instead is the brief text
itself: a spawned agent receives its brief verbatim as its first user turn, so a 120-character
probe taken 30% into the brief (past the preamble a coordinator reuses across siblings)
identifies the child. 41 briefs were spawned more than once; for those the earliest child
starting at or after the spawn timestamp wins, which is route (c) used only as a tiebreak.
15 spawns link to nothing — briefs too short to probe, or children whose transcripts are gone.

**The bootstrap arm is thin, and will stay thin.** Of 515 session records across 28 live
initiatives plus the retired `active-work-2026-09` archive, only 73 carry a `session_id` that
is a uuid with a transcript still on disk. 235 carry a hand-written slug that pre-dates
transcript ids entirely, and 192 carry a uuid whose `.jsonl` has since been pruned. Reading
the `session_01…` id back out of the `https://claude.ai/code/…` url that Claude Code stamps
into a transcript recovered 13 more. 35 usable pairs is the honest ceiling on this corpus;
read its rows as directional.

### What the labels actually are

| Arm | Labels | With a `note:`/`source:`/`task:` ref | Pairs with ≥1 workspace label |
| --- | ---: | ---: | ---: |
| spawn | 7,355 | 205 (**2.8%**) | 181 of 608 (30%) |
| bootstrap | 3,427 | 164 (**4.8%**) | 24 of 35 (69%) |

This is the most consequential number in the report and it is not about ranking. **What an
agent opens after being briefed is overwhelmingly repository code**, which the workspace
index does not contain and no workspace retriever can return. Scoring only against the full
label set would make every candidate look broken for a reason that has nothing to do with
how it ranks.

So every cell is scored twice:

- **`all`** — all labels. Answers "how much of the agent's subsequent reading could a
  workspace retriever have replaced". A ceiling of roughly 0.03 exists by construction on
  the spawn arm.
- **`workspace`** — only labels under the active-work root. Answers "of the documents this
  retriever could possibly have returned, how many did it rank". This is the ranking
  question, and the one to use when comparing candidates.

Both come from the same search per pair.

## Candidates

| Name | What it is | `chars@5` measures |
| --- | --- | --- |
| `date-order-notes` | The production baseline: newest notes by filename date, query ignored. 5 on the spawn arm (agent-chat `MAX_NOTES`), 12 on the bootstrap arm (the pre-TP-26 bootstrap) | whole file size |
| `active-work-search` | The shipped per-class RRF search, as a subprocess against the installed `active-work` 0.8.0 | excerpt length |
| `notes-fts` | The notes-only span search the bootstrap runs, mirroring `rank-notes.ts` (`note:` prefix, OR of quoted terms, depth 300) | matched span length |
| `hybrid-fts-vector` | `notes-fts` fused by RRF (k=60) with a `HashEmbedder` brute-force vector index over every note | matched span length, else a 200-char excerpt |

`chars@5` is **not comparable across candidates** — each reports what it would itself cost a
prompt, and the baseline injects whole files while the others inject excerpts.

`hybrid-fts-vector` runs with no model and no network. `HashEmbedder` is feature hashing,
not semantics; it is a floor for the seam, not a serious dense retriever. A real embedder is
a swap behind `Embedder`.

## Query variants

A spawn brief has a median of 3,565 characters and FTS ORs every token, so passing it whole
ranks on document length rather than subject. Two derivations are measured:

- **`heading-lead`** — the first markdown heading plus the first 30 non-stop-word tokens.
- **`top-df`** — the 12 rarest terms by document frequency across the pair corpus.

## Results

### Spawn arm — `workspace` scope (the ranking question)

181 pairs. Best row in bold.

| Candidate | Variant | R@5 | R@10 | P@5 | MRR | chars@5 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `date-order-notes` | either | 0.006 | 0.006 | 0.003 | 0.008 | 4,750 |
| `active-work-search` | heading-lead | 0.050 | 0.103 | 0.024 | 0.075 | 797 |
| `active-work-search` | **top-df** | **0.076** | **0.203** | **0.030** | **0.092** | **772** |
| `notes-fts` | heading-lead | 0.049 | 0.051 | 0.023 | 0.058 | 13,446 |
| `notes-fts` | top-df | 0.052 | 0.054 | 0.022 | 0.056 | 11,968 |
| `hybrid-fts-vector` | heading-lead | 0.026 | 0.045 | 0.010 | 0.035 | 9,533 |
| `hybrid-fts-vector` | top-df | 0.040 | 0.052 | 0.015 | 0.036 | 7,858 |

### Bootstrap arm — `workspace` scope

24 pairs. Directional only; see the link-rate caveat.

| Candidate | Variant | R@5 | R@10 | P@5 | MRR | chars@5 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `date-order-notes` | either | 0.000 | 0.002 | 0.000 | 0.007 | 3,857 |
| `active-work-search` | heading-lead | 0.006 | 0.071 | 0.017 | 0.080 | 800 |
| `active-work-search` | **top-df** | 0.000 | **0.075** | 0.000 | 0.076 | 776 |
| `notes-fts` | heading-lead | 0.006 | 0.011 | 0.017 | 0.060 | 9,158 |
| `notes-fts` | top-df | 0.000 | 0.000 | 0.000 | 0.000 | 4,505 |
| `hybrid-fts-vector` | heading-lead | 0.006 | 0.006 | 0.017 | 0.024 | 7,766 |
| `hybrid-fts-vector` | top-df | 0.000 | 0.000 | 0.000 | 0.000 | 3,874 |

### `all` scope

Every candidate lands between 0.000 and 0.015 on R@10, on both arms. That is the coverage
ceiling described above, not a ranking result: 97.2% of spawn labels are files no workspace
retriever can name. The best row is `active-work-search` + `top-df` on the spawn arm at
R@10 0.015. These rows are here to be honest about the denominator, not to rank anything.

Full 32-row grid, both scopes: run `retrieval-eval run pairs.jsonl`.

### What the numbers say

**Relevance beats date order by a wide margin, and costs a fifth as much.** On the spawn arm
`active-work-search` reaches R@10 0.203 against the baseline's 0.006 — a factor of 34 — while
injecting 772 characters per query against the baseline's 4,750. Today's mechanism spends
~4.7 KB per spawn to hit 0.6% of what the agent went on to open. This is the result that
justifies building shape 2, and it is the one to re-run when the weights change.

**`top-df` beats `heading-lead`, and the gap is the whole decision.** For
`active-work-search` on the spawn arm, picking the 12 rarest terms doubles R@10 over taking
the heading and the first 30 words (0.203 vs 0.103). Briefs front-load boilerplate — role,
reporting instructions, constraints — so the opening words are the least discriminating part
of the document. Whatever ships as the spawn-time query step should derive terms by rarity,
not by position.

**Notes-only retrieval saturates almost immediately.** `notes-fts` gains nothing between k=5
and k=10 (0.049 → 0.051), while `active-work-search` nearly triples (0.076 → 0.203). The
notes-only query collapses to a handful of distinct owners, so the extra five slots are
empty. Multi-class search is not a nicety here; it is where the recall past rank 5 comes
from. It also argues that the bootstrap's notes-only ranker is leaving recall on the table.

**The vector seam is plumbing, not an improvement.** `hybrid-fts-vector` is at or below
`notes-fts` everywhere (spawn heading-lead 0.045 vs 0.051). That is the expected result:
`HashEmbedder` is feature hashing, so fusing it with FTS adds lexical noise to a lexical
list. The value delivered is the seam and this floor — a real embedder now has a number to
beat before it earns its dependency.

**`notes-fts` is the most expensive candidate by an order of magnitude** (13,446 chars@5
against 797). It reports matched span length, and spans in this graph are large. Any design
that injects spans rather than excerpts should budget for that.

### Known distortions

- **`terms()` drops tokens of two characters or fewer**, mirroring `rank-notes.ts`. Both
  halves of `TP-84` are two characters, so a task reference contributes nothing to any
  query here. Since briefs and open loops cite task ids constantly, this is suppressing real
  signal in production, not only in the harness.
- **The bootstrap arm's 24 workspace pairs** are too few for its ordering to be trusted.
  Its one clear signal — `active-work-search` far above everything else at k=10 — agrees
  with the spawn arm's, which is why it is reported at all.
- **`chars@5` is not comparable across candidates.** Excerpt, span and whole-file are three
  different things; each candidate reports what it would itself cost.

## Shape 1: does anyone call a recall tool?

Counted over the same 759 transcripts (`retrieval-eval uptake`).

| Class | Calls | Transcripts using it at least once |
| --- | ---: | ---: |
| `bash-search` (`rg`, `grep`, `find`, `fd`, `ag`) | 17,045 | 577 |
| `fs-search` (`Grep`, `Glob`) | 2,028 | 374 |
| `recall-mcp` (any MCP tool whose name reads as search) | 297 | 29 |
| `recall-cli` (`active-work search`, playbook recall) | 14 | 5 |

Of the 297 `recall-mcp` calls, **2** are `mcp__active-work__active__search`. The rest are
Gmail, Chrome and the exercise catalog. Workspace recall, across 727 transcripts with tool
use, was invoked 16 times in 6 of them, against 19,073 filesystem searches.

This reproduces the 2026-09-15 baseline (16,949 / 2,028 / 2 / 11) on a corpus one day
larger; the `recall-cli` count of 14 includes three probe calls made while building this
harness.

Shape 1 does not need more tuning. It needs to stop being optional.

## 2026-09-18: nomic through the vector seam, before and after the prefix fix

TP-168. Until embed 0.2 / retrieval 0.3, `vectorRetriever` prepended `search_query: ` to a
nomic query and `OllamaEmbedder` then prepended `search_document: `, so every nomic query was
embedded as `search_document: search_query: <q>`. The fix moves prefixes into the embedder,
one per text by role.

**The 2026-09-15 tables above are unaffected.** They ran `hybrid-fts-vector` over
`HashEmbedder`, which has no prefixes and was never given one, so the fix cannot change them.
To measure the fix, `run` gained `--embedder ollama` (default `hash`), and both builds were
run with Ollama `nomic-embed-text` over the same freshly mined pair file. The corpus has grown
since 2026-09-15 (2,286 transcripts, 755 spawn and 47 bootstrap pairs; snapshot below), so
compare rows within this section only, not against the tables above.

`workspace` scope. "hash" is today's default, on the same pairs. `notes-fts` rows were
identical before and after, as they must be, and are omitted. No candidate threw.

| Arm (pairs) | Variant | Embedder | R@5 | R@10 | P@5 | MRR | chars@5 |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| spawn (246) | heading-lead | hash | 0.021 | 0.036 | 0.008 | 0.027 | 8,639 |
| spawn (246) | heading-lead | nomic, double prefix | 0.020 | 0.037 | 0.010 | 0.029 | 4,344 |
| spawn (246) | heading-lead | nomic, fixed | 0.020 | 0.037 | 0.010 | 0.027 | 4,659 |
| spawn (246) | top-df | hash | 0.031 | 0.038 | 0.013 | 0.036 | 7,613 |
| spawn (246) | top-df | nomic, double prefix | 0.035 | 0.043 | 0.017 | 0.034 | 6,060 |
| spawn (246) | top-df | nomic, fixed | 0.031 | 0.043 | 0.014 | 0.032 | 6,067 |
| bootstrap (31) | heading-lead | hash | 0.021 | 0.021 | 0.019 | 0.032 | 7,068 |
| bootstrap (31) | heading-lead | nomic, double prefix | 0.000 | 0.002 | 0.000 | 0.004 | 6,425 |
| bootstrap (31) | heading-lead | nomic, fixed | 0.000 | 0.002 | 0.000 | 0.004 | 3,905 |
| bootstrap (31) | top-df | hash | 0.016 | 0.016 | 0.006 | 0.032 | 3,451 |
| bootstrap (31) | top-df | nomic, double prefix | 0.016 | 0.016 | 0.006 | 0.016 | 3,628 |
| bootstrap (31) | top-df | nomic, fixed | 0.016 | 0.016 | 0.006 | 0.016 | 3,757 |

For reference on the same pairs, `notes-fts` scores spawn heading-lead R@10 0.038, spawn
top-df R@10 0.043 and MRR 0.046.

**The fix does not move this eval.** Only spawn top-df shifts, down one to four thousandths
(R@5 0.035 to 0.031, MRR 0.034 to 0.032), and R@10 is unchanged everywhere. On 246 pairs that
is a handful of hits, well inside noise. The prefix was a correctness bug, not the reason
the vector seam fails to beat `notes-fts`. nomic, fixed or not, does not beat FTS alone here.
One untested explanation: each note is one whole-note vector, and Ollama truncates long input
to the model's context, so the vector sees only the start of a long note.

Snapshot for this section:

```json
{
  "takenAt": "2026-09-18T20:03:53.564Z",
  "transcripts": 2286,
  "transcriptRange": { "first": "2026-08-11T11:28:23.126Z", "last": "2026-09-18T19:49:47.532Z" },
  "graph": { "bytes": 275095552, "modified": "2026-09-18T20:02:12.997Z" },
  "activeWorkVersion": "0.9.0"
}
```

## Reproducing

```sh
pnpm --filter @titan-design/retrieval-eval build
node products/retrieval-eval/dist/bin.js mine --out pairs.jsonl   # stats to stderr
node products/retrieval-eval/dist/bin.js run pairs.jsonl
node products/retrieval-eval/dist/bin.js run pairs.jsonl --candidates notes-fts,hybrid-fts-vector --embedder ollama
node products/retrieval-eval/dist/bin.js uptake --since 2026-09-01
```

## Corpus

Recorded so a disagreeing re-run is attributable. The graph is written continuously by the
daemon, so these numbers move hourly.

```json
{
  "takenAt": "2026-09-16T01:39:25.362Z",
  "transcripts": 759,
  "transcriptRange": {
    "first": "2026-08-11T11:28:23.126Z",
    "last": "2026-09-16T01:22:16.232Z"
  },
  "graph": {
    "path": "~/Library/Application Support/active-work/.miner/graph.sqlite3",
    "bytes": 271687680,
    "modified": "2026-09-16T01:38:51.392Z"
  },
  "activeWorkVersion": "0.8.0"
}
```

- Transcripts: 759 across `~/.claude/projects` and three profiles under
  `~/.claude-profiles`, 2026-08-11 to 2026-09-16. 727 contain at least one tool call.
- Session records: 515, over 28 live initiatives plus the `active-work-2026-09` archive.
- Graph: 259 MiB, WAL, opened `readonly: true`.
- `active-work --version`: 0.8.0, the installed binary the daemon runs.
- Harness: `@titan-design/retrieval-eval` at the commit this file ships in.
