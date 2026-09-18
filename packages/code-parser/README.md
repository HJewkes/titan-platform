# @titan-design/code-parser

Tree-sitter WASM parsing for TypeScript, TSX and Python, plus the source-file filter and the
`Extractor` contract that code analyzers are written against.

Tier 0 of the titan-platform DAG. No `@titan-design` dependencies. Extracted from
`@titan-design/code-graph` (TP-125), which had ported it byte-for-byte from codewatch's
`@codewatch/core`, so an analyzer can parse source without inheriting ts-morph and a SQLite
graph store.

```sh
npm install @titan-design/code-parser web-tree-sitter@^0.26.6
```

```ts
import { parseFile, shouldIncludeFile, type Extractor } from "@titan-design/code-parser";

if (shouldIncludeFile("src/greet.py", ["python"])) {
  const file = await parseFile("def greet(name):\n    return name\n", "src/greet.py", "python");
  file.tree.rootNode.type; // "module"
}

const functionSources: Extractor<string> = {
  name: "functions",
  extract: (file) => file.tree.rootNode.descendantsOfType("function_definition").map((n) => n?.text ?? ""),
};
```

## API

- `parseFile(content, filePath, language)` returns a `ParsedFile` (`tree`, `content`,
  `filePath`, `language`). `language` is one of `getSupportedLanguages()`: `typescript`,
  `tsx`, `python`. Anything else rejects with `Unsupported language: <name>`.
- `shouldIncludeFile(path, languages)` accepts a path whose extension belongs to one of the
  languages and that sits under no excluded directory (`node_modules`, `dist`, `.git`,
  `.claude`, and others) and matches no excluded pattern (`.d.ts`, `.min.js`, lock files).
- `isExcludedDir(name)` prunes the same directories during a recursive walk.
- `getLanguageFromPath(path)` maps an extension to a filter language, or `null`.
- `Extractor<T>` is `{ name, extract(file: ParsedFile): T[] }`.

## Dependencies

`web-tree-sitter` is a peer dependency. `ParsedFile.tree` is a web-tree-sitter `Tree`, and
consumers walk it with web-tree-sitter's `Node` type, so both sides must see one copy. The
grammar packages (`tree-sitter-typescript`, `tree-sitter-python`) are regular dependencies:
only this package touches them, and it resolves their `.wasm` files relative to its own
installed location. Their native install scripts are not needed; pnpm 10 can leave them
unapproved.

## Gotchas

- The filter knows `javascript` (`.js`, `.jsx`) but the parser has no JavaScript grammar. A
  `.js` file passes `shouldIncludeFile(path, ["javascript"])`, `getLanguageFromPath` says
  `javascript`, and `parseFile` then rejects it. `javascript-gap.test.ts` pins this until a
  grammar is added.
- The filter's language names and the parser's differ: `.tsx` files map to `typescript` in
  the filter but parse cleanly only with `tsx`.
- WASM initialisation and each grammar load happen once per process, on first use.
