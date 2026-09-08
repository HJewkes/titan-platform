# @titan-design/locator

Byte-offset provenance for line-oriented transcripts. A locator is
`[transcriptIndex, byteOffset, byteLength]`: a pointer into a file, never a copy of the
text, so an index stays small and nothing drifts.

Tier 0 of the titan-platform DAG. No dependencies. Extracted from active-work's session
miner (TP-5).

## Reading lines with exact offsets

```ts
import { readJsonLines, nextOffset } from "@titan-design/locator";

let watermark = entry.lastByteOffset;
for await (const line of readJsonLines(path, watermark)) {
  const locator = [transcriptIndex, line.byteOffset, line.byteLength] as const;
  watermark = nextOffset(line);
}
```

`readJsonLines` splits on raw `\n` bytes so offsets are exact on CRLF and multibyte
content, and withholds a trailing partial line so a watermark never lands mid-record.

## The transcript table

`transcriptIndexFor(table, path)` assigns each file a stable index on first sight. Rows
are append-only because every stored locator names one. `resumePoint(entry, path)`
reports `unchanged`, `appended`, `rewritten` (file shorter than the watermark, or a
prefix-hash mismatch with `verifyHash`), or `missing`, and the byte to resume from.
Persisting the table is the caller's job; `atomicWrite` is here for that.

## Resolving a locator

`readLocatorText(path, locator)` returns the addressed bytes and throws if the file has
shrunk past them. For durability, `mirrorFile(source, dir)` keeps a content-addressed
copy and `resolveSource(source, dir, hash)` falls back to it when the source is gone.

## Formatting

`formatLocator` and `parseLocator` round-trip the compact `index:offset:length` form for
URLs and CLI arguments. `isLocator` is the runtime guard.
