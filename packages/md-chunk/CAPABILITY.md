# md-chunk: use this when

<!-- One to three sentences for a reader deciding whether to reuse this or build something new. Feeds CAPABILITIES.md. -->

You need the structure of a markdown file as byte ranges that read back to the exact source bytes: frontmatter, headings, fences, tables and paragraphs, with fence state so a `# comment` in code is never a heading. To read the bytes back later, store the range in a `locator`; to embed text, use `embed`.
