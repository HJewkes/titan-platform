---
"@titan-design/code-graph": minor
---

Add `renderSignatureTree(nodes, { maxLineChars })`, a pure signatures-only tree render for LLM context: a header per file, one line per symbol (`attrs.signature`, else `<name> (<kind>)`) in line order, an `ELISION_MARKER` line between non-adjacent symbols, and every line truncated at `maxLineChars` (default `DEFAULT_MAX_LINE_CHARS`).
Usage: `import { renderSignatureTree } from "@titan-design/code-graph"; const text = renderSignatureTree(graph.nodes, { maxLineChars: 100 });`
