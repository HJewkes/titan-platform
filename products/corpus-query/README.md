# @titan-design/corpus-query

Answer "list every X" over a large local text corpus cheaply: a deterministic paragraph index,
a deterministic retrieve, then small verified model calls.

Tier product of the titan-platform DAG. Private; not published.

```sh
corpus-query index <root> [--layout archive|plain] [--db <file>]
```

`index` prints `documents, indexed, unchanged, removed, skipped, headerless, paragraphs`. The
database lives under the per-user data directory, one per corpus root, never in the repo. It
stores paragraph locators and FTS5 tokens only; passage text is re-read from the files by byte
range (`readSpanText`).

## Asking a question

```sh
corpus-query ask "<question>" --corpus <root> [--index <file>] [--rules <file>] [--spec <file>]
                 [--screen-model haiku] [--confirm-model sonnet] [--concurrency 4] [--rounds 2] [--budget-usd 3]
corpus-query resume <runId>
```

`ask` is two durable workflow runs. `cq-compile` turns the question into a `QuerySpec` with one call;
`cq-answer` is keyed by that spec's hash, because its judge prefixes are built from the spec. Every judge
call is a bare `claude -p` (no tools, MCP servers, settings or skills), so the system prompt is the
cached prefix and the batch is the only other input.

- **screen** (haiku): batches of about 6k tokens, each ending in a canary. One warm call runs alone first,
  so its cache write is readable by the rest of the wave.
- **redo**: a refusal, an invalid payload or a mis-judged canary gets one redo on sonnet; if that fails too
  the batch is recorded unjudged and the wave goes on.
- **grow**: names the judges report are searched for next round, until no name is new or `--rounds` is hit.
- **confirm** (sonnet): one call per book, holding that book's candidate passages.

Run state and artifacts live under the per-user data directory: `runs/<runId>/spec.json`,
`screen/r<n>/<batchKey>.json` and `confirm/<batchKey>.json` (verified verdicts, voids, usage), and
`answer.json` (rows and coverage). Ctrl-C releases the run; `resume` replays finished batches from the
record and dispatches only the rest. The state database holds rendered prompts, so it is corpus text:
never attach it to an issue or pull request.

## Layouts

A `CorpusLayout` maps a relative path and file text to a `ChapterMeta` (id, ref, series, book,
chapter, story-order key), or `undefined` to skip the file.

- `archive`: `<series>/book_NN/chapter_KK[_preseason_N].txt` and `other/<date>_<slug>.txt`, each with
  `TITLE: <code> - <title>`, `PUBLISHED` and `POST_ID` header lines. The ref is the TITLE code. Reading order
  is `player-manager`, `soccer-supremo`, `dof`, any other series by name, then `other/` by publish date.
- `plain`: one `.txt` file is one document, ordered by path; header lines are optional.

Tests use a synthetic corpus written to a temp directory. Do not commit text from a real corpus.
