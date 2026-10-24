---
"@titan-design/md-chunk": minor
---

New tier-0 package. `scanBlocks(source)` returns the top-level frontmatter, heading, fence, table and paragraph blocks of a markdown string or UTF-8 bytes, each with a half-open byte range and a 1-based line range. It tracks fence state, so a `# comment` inside a backtick or tilde fence is not a heading; a fence closes only on a run of the same character at least as long, and an unclosed fence runs to the end with `closed: false`. Lines split on `\n` bytes, so CRLF and multi-byte text keep exact offsets.
