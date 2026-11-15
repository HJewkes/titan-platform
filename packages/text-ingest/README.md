# text-ingest

**Tier 1.** No titan dependencies yet.

```sh
npm install @titan-design/text-ingest
```

## The problem it solves

A raw transcript is full of fillers, stutters, sponsor reads and repeated paragraphs, and any
cleaning that rewrites the text breaks the byte ranges an index points at. `cleanTranscript`
never rewrites: it returns the byte ranges of the source to keep, plus every removed span
tagged with why it went.

## When to reach for it

Before chunking or indexing a transcript. It is a pure function of the source and the options,
so the same input always gives the same ranges. For the byte-range pointer type use `locator`;
for fused retrieval use `retrieval`.

## Example

```ts
import { cleanTranscript } from "@titan-design/text-ingest";

const source = "Um, so the the plan is, you know, simple.";
const { kept, removed } = cleanTranscript(source);
const bytes = Buffer.from(source);
const cleaned = Buffer.concat(kept.map((r) => bytes.subarray(r.start, r.end))).toString();
// cleaned === "so the plan is, simple."
// removed[i].kind is "filler" or "repeat"
```

Options: `cutRanges` (byte ranges to drop, tagged `sponsor-cut`) and `nearDuplicateThreshold`
(drops a paragraph whose three-word-shingle Jaccard against an earlier paragraph is at or above
it, tagged `near-duplicate`).

## What it deliberately does not do

It does not fetch SponsorBlock segments or map them to byte ranges; the caller supplies the
ranges. It does not chunk, embed or index.

## Gotchas

- All offsets are UTF-8 byte offsets, not string indices.
- Near-duplicate removal is off unless `nearDuplicateThreshold` is set.
- Where kinds overlap, the order is sponsor-cut, near-duplicate, filler, repeat; the later kind
  keeps only the bytes the earlier ones did not cover.
- A repeat span is the second copy plus the gap before it, so the first copy survives.

## Where it came from

New. No titan package cleaned transcripts before this one.
