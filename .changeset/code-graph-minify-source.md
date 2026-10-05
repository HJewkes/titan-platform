---
"@titan-design/code-graph": minor
---

Add `minifySource(text, language)`, a safe minify for source emitted into LLM context. For TypeScript, TSX and Python it drops comments and docstrings, strips trailing whitespace, collapses blank-line runs and replaces a leading import block with one `importMarker` line (`// … N imports`, `# … N imports` in Python). It never renames or dedents, and other languages come back unchanged with an identity line map.

Usage: `const { text, lineMap } = await minifySource(source, "typescript");` then `originalLine({ text, lineMap }, n)` gives the 1-based file line of output line `n`; the marker maps to the first import line.
