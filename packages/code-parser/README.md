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
  `tsx`, `python`. Anything else rejects with `Unsupported language: <name>`. A `.tsx` path
  passed as `typescript` parses with the `tsx` grammar, so the filter's answer can be passed
  straight through; `ParsedFile.language` stays the name you passed.
- `shouldIncludeFile(path, languages)` accepts a path whose extension belongs to one of the
  languages and that sits under no excluded directory (`node_modules`, `dist`, `.git`,
  `.claude`, and others) and matches no excluded pattern (`.d.ts`, `.min.js`, lock files).
- `isExcludedDir(name)` prunes the same directories during a recursive walk.
- `getLanguageFromPath(path)` maps an extension to a filter language, or `null`. The filter
  knows `typescript` (`.ts`, `.tsx`) and `python` (`.py`). `.js` and `.jsx` map to `null` and
  never pass `shouldIncludeFile`, so a walk skips them instead of handing `parseFile` a file
  it cannot parse.
- `Extractor<T>` is `{ name, extract(file: ParsedFile): T[] }`.

## Dependencies

`web-tree-sitter` is a peer dependency. `ParsedFile.tree` is a web-tree-sitter `Tree`, and
consumers walk it with web-tree-sitter's `Node` type, so both sides must see one copy. The
grammar packages (`tree-sitter-typescript`, `tree-sitter-python`) are regular dependencies:
only this package touches them, and it resolves their `.wasm` files relative to its own
installed location. Their native install scripts are not needed; pnpm 10 can leave them
unapproved.

## Gotchas

- There is no JavaScript support. Before 0.1.0 the filter accepted `.js` and `.jsx` as
  `javascript` and `parseFile` then rejected them; now the filter drops them.
- The tsx grammar still reports an error for a bare `&` or a numeric entity (`&#128196;`)
  in JSX text. Six of 542 `.tsx` files in titan-design's `packages/ui/src` hit this.
- WASM initialisation and each grammar load happen once per process, on first use.
