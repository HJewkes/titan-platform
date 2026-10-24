# md-chunk

**Tier 0 · primitives.** No dependencies at all.

```sh
npm install @titan-design/md-chunk
```

Status: pre-release. This version ships the block scanner only; `chunkMarkdown` and
`chunkJson` follow before the first published release.

## The problem it solves

Search indexes here are contentless: a span row holds a byte range, and the excerpt is read
back from the file. A chunker that returns copied text cannot feed them. Splitting markdown
on `/^#{1,6}\s/` also splits on a `# comment` inside a code fence.

`scanBlocks` walks the bytes once, tracks fence state, and returns each top-level block as a
half-open byte range that reads back to the exact source bytes.

## When to reach for it

You index or embed markdown and need its structure as ranges: frontmatter, ATX headings,
fenced code, pipe tables and paragraphs. To store and resolve a range later, use
[`locator`](/reference/locator). To embed text, use [`embed`](/reference/embed).

## Example

Verified against the unreleased 0.0.0.

```ts
import { scanBlocks } from "@titan-design/md-chunk";

const blocks = scanBlocks("# Setup\n\n```sh\n# install deps\n```\n");
// [
//   { kind: "heading", level: 1, text: "Setup", start: 0, end: 8, startLine: 1, endLine: 1 },
//   { kind: "fence", closed: true, start: 9, end: 34, startLine: 3, endLine: 5 },
// ]
```

## The surface

| Export | What it does |
| --- | --- |
| `scanBlocks(source)` | `string` or UTF-8 `Uint8Array` to `Block[]`, in document order |
| `Block` | a union on `kind`: `frontmatter`, `heading` (`level`, `text`), `fence` (`closed`), `table`, `paragraph` |
| `BlockRange` | `start`, `end` (bytes, half-open), `startLine`, `endLine` (1-based, inclusive) |

## What it deliberately does not do

- It does not parse YAML. It only finds where frontmatter (`---` to `---` or `...` on the
  first line) ends.
- It does not recognise setext headings, indented code, lists or block quotes as their own
  blocks. They read as paragraphs.
- It does not return text, except a heading's own text.

## Gotchas

- Offsets are UTF-8 byte offsets, not string indexes. Slice the encoded bytes, not the string.
- Blank lines between blocks belong to no block, so the blocks do not tile the document.
- An unclosed fence runs to the end of the document with `closed: false`.

## Where it came from

New. It replaces the fence-unaware heading splitters in active-work's workspace index and in
brain's markdown parser, which the later chunker slices swap out.
