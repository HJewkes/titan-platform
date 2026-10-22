# @titan-design/corpus-query

Answer "list every X" over a large local text corpus cheaply: a deterministic paragraph index,
a deterministic retrieve, then small verified model calls. This slice ships the index.

Tier product of the titan-platform DAG. Private; not published.

```sh
corpus-query index <root> [--layout archive|plain] [--db <file>]
```

`index` prints `documents, indexed, unchanged, removed, skipped, headerless, paragraphs`. The
database lives under the per-user data directory, one per corpus root, never in the repo. It
stores paragraph locators and FTS5 tokens only; passage text is re-read from the files by byte
range (`readSpanText`).

## Layouts

A `CorpusLayout` maps a relative path and file text to a `ChapterMeta` (id, ref, series, book,
chapter, story-order key), or `undefined` to skip the file.

- `archive`: `<series>/book_NN/chapter_KK[_preseason_N].txt` and `other/<date>_<slug>.txt`, each with
  `TITLE: <code> - <title>`, `PUBLISHED` and `POST_ID` header lines. The ref is the TITLE code. Reading order
  is `player-manager`, `soccer-supremo`, `dof`, any other series by name, then `other/` by publish date.
- `plain`: one `.txt` file is one document, ordered by path; header lines are optional.

Tests use a synthetic corpus written to a temp directory. Do not commit text from a real corpus.
