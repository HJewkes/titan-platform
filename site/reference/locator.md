# locator

**Tier 0 · primitives.** No dependencies at all.

```sh
npm install @titan-design/locator
```

## The problem it solves

You are indexing a growing line-oriented file and you want to point at a piece of it later.
Copying the text into your index doubles the corpus and lets the copy drift. Storing a line
number breaks the moment the file is rewritten.

A **locator** is `[transcriptIndex, byteOffset, byteLength]`: a pointer into a file, never a
copy of the text. An index stays small and nothing drifts.

## When to reach for it

Any incremental read of an append-mostly file where you need to (a) resume exactly where you
stopped and (b) point back at the bytes that produced a row. Transcripts, logs, JSONL
exports.

## Example

Verified against 0.1.0.

```ts
import { formatLocator, nextOffset, readJsonLines, readLocatorText } from "@titan-design/locator";

let watermark = 0;
const locators: [number, number, number][] = [];

for await (const line of readJsonLines(path, watermark)) {
  locators.push([0, line.byteOffset, line.byteLength]); // 0 = this file's transcript index
  watermark = nextOffset(line);
}
// over a two-line file: [[0, 0, 7], [0, 8, 7]], watermark 16

await readLocatorText(path, locators[1]);  // '{"a":2}'
formatLocator(locators[1]);                // '0:8:7'
```

`readJsonLines` splits on raw `\n` bytes, so offsets are exact on CRLF and multibyte
content, and it **withholds a trailing partial line** so a watermark never lands mid-record.

## The surface

| Function | What it does |
| --- | --- |
| `readJsonLines(path, fromOffset)` | async iterator of `{ byteOffset, byteLength, ... }` raw lines |
| `nextOffset(line)` | the offset to resume from after that line |
| `readLocatorText` / `readLocatorBytes` | resolve a locator; throws if the file shrank past it |
| `transcriptIndexFor(table, path)` | assigns each file a stable index on first sight |
| `resumePoint(entry, path)` | `unchanged` / `appended` / `rewritten` / `missing`, plus the byte to resume from |
| `mirrorFile(source, dir)` / `resolveSource` | content-addressed copy, and fallback to it when the source is gone |
| `formatLocator` / `parseLocator` / `isLocator` | the compact `index:offset:length` form for URLs and CLI arguments |
| `contentHash` / `prefixHash` | the hashes `resumePoint` compares |
| `atomicWrite` | temp-file + rename, for persisting the transcript table |

## Gotchas

**The transcript table is append-only** because every stored locator names an index into it.
Persisting it is the caller's job; `atomicWrite` is here for that.

**`rewritten` is detected two ways**: the file is shorter than the watermark, or (with
`verifyHash`) the prefix hash of the already-indexed bytes no longer matches. Without
`verifyHash`, a same-length rewrite is invisible.

**Durability is opt-in.** A locator into a file the tool later deletes resolves to nothing
unless you mirrored it.

## Where it came from

active-work's session miner. Extracted whole; nothing was left behind.
