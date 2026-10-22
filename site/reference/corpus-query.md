# corpus-query

**Product.** Private, never published. Depends on `@titan-design/app-paths`,
`@titan-design/evidence`, `@titan-design/store-sqlite`, `commander` and `zod`.

```sh
pnpm --filter @titan-design/corpus-query build
node products/corpus-query/dist/bin.js index <root> [--layout archive|plain] [--db <file>]
```

## The problem it solves

Questions of the form "list every X" over a large local text corpus were answered by
handing a model whole chapters, which is slow, costly and unrepeatable. This product splits
the job into a deterministic paragraph index, a deterministic retrieve, then small verified
model calls. Slice S1 (TP-3832) ships the index.

`index` walks `<root>`, asks the layout what each file is, splits each document into
paragraphs on blank lines and writes one FTS5 row per paragraph. It prints
`documents, indexed, unchanged, removed, skipped, headerless, paragraphs`.

- **No prose stored.** The search table is contentless (`content=''`): it keeps tokens and
  each paragraph's byte offset and length, never the text. `readSpanText` re-reads a passage
  from the file by byte range, so offsets are bytes, not characters, and multibyte text
  stays aligned.
- **Re-runs are incremental.** A file whose sha-256 is unchanged is skipped. A changed file
  is cleared and re-indexed in one transaction; a file that vanished is removed.
- **One database per corpus.** By default the index lives under the per-user data
  directory (`appDirs("corpus-query").data`), keyed by a hash of the resolved root, never in
  the repo. `--db` overrides it.

## Layouts

A `CorpusLayout` maps a relative path and the file's text to a `ChapterMeta` (id, ref,
series, book, chapter, story-order key), or `undefined` to skip the file.

- `archive` (the default): `<series>/book_NN/chapter_KK[_preseason_N].txt` and
  `other/<date>_<slug>.txt`, each with `TITLE: <code> - <title>`, `PUBLISHED` and `POST_ID`
  header lines. The ref is the TITLE code. Reading order is `player-manager`,
  `soccer-supremo`, `dof`, any other series by name, then `other/` by publish date.
- `plain`: one `.txt` file is one document, ordered by path; header lines are optional.

## Example

Verified against `0.0.0` (the workspace version).

```ts
import { openDatabase } from "@titan-design/store-sqlite";
import { indexCorpus, listChapters, plainLayout } from "@titan-design/corpus-query";

const db = openDatabase("/tmp/corpus/index.sqlite3");
const stats = indexCorpus(db, "/path/to/corpus", plainLayout);
console.log(stats.indexed, stats.paragraphs, listChapters(db).length);
db.close();
```

## What it deliberately does not do

- It does not retrieve or answer questions yet; those are later slices of TP-3832.
- It does not store or ship corpus text. Tests build a synthetic corpus in a temp
  directory; never commit text from a real corpus.

## Gotchas

- The default layout is `archive`. A plain folder of `.txt` files indexed without
  `--layout plain` reports every file as skipped.
- Switching layout on an existing database does not re-describe unchanged files: they keep
  the ids the earlier layout gave them. Use a fresh `--db` when changing layout.
- Archive chapter ids drop zero-padding, so `book_1/chapter_1.txt` and
  `book_01/chapter_01.txt` in the same corpus get the same id, and the run fails on the
  chapter table's UNIQUE constraint.
- Every file under the root is read in full before the layout decides whether to skip it.

## Where it came from

New. Scaffolded under TP-3832 slice S1.
