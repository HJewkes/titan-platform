# @titan-design/md-chunk

Markdown structure as byte ranges. `scanBlocks(source)` returns the top-level frontmatter,
heading, fence, table and paragraph blocks of a `string` or UTF-8 `Uint8Array`, each with a
half-open byte range `[start, end)` and a 1-based inclusive line range.

```ts
import { scanBlocks } from "@titan-design/md-chunk";

scanBlocks("# Setup\n\n```sh\n# install deps\n```\n");
// [
//   { kind: "heading", level: 1, text: "Setup", start: 0, end: 8, startLine: 1, endLine: 1 },
//   { kind: "fence", closed: true, start: 9, end: 34, startLine: 3, endLine: 5 },
// ]
```

- Offsets index the UTF-8 bytes. Lines split on `\n` only, so CRLF files keep exact offsets.
- Fences open on 3 or more backticks or tildes and close on a run of the same character at
  least as long. An unclosed fence runs to the end and reports `closed: false`.
- Headings are ATX only. Setext headings are not recognised.
- Blank lines between blocks belong to no block.

Tier 0 of the titan-platform DAG, with no runtime dependencies. The `package-layers` rule in
`.codewatch/check.json` enforces the tier in CI.
