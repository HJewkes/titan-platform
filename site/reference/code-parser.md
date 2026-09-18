# code-parser

**Tier 0 · primitives.** No titan dependencies. Peer: `web-tree-sitter`.

```sh
npm install @titan-design/code-parser web-tree-sitter@^0.26.6
```

## The problem it solves

Tree-sitter parsing in Node needs three fiddly things done once: initialise the WASM
runtime, find each grammar's `.wasm` file inside an installed package, and cache one parser
per language. Code analyzers also need to agree on which files count as source and on the
shape of a parsed file. This package owns those four pieces: `parseFile`, the file filter,
`ParsedFile`, and the `Extractor<T>` contract.

## When to reach for it

You are writing an analysis over TypeScript, TSX or Python syntax trees and want nothing
else. Reach for [`code-graph`](/reference/code-graph) instead when you need the import graph,
ts-morph symbol resolution, or a stored snapshot; it builds on this package and re-exports
its API.

## Example

Verified from a packed tarball installed outside the workspace, before the 0.1.0 version bump.

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

## What it deliberately does not do

No JavaScript grammar, no languages beyond TypeScript, TSX and Python, and no file walking:
`isExcludedDir` and `shouldIncludeFile` are predicates, and the caller owns the traversal.
It does not resolve imports or types; that is ts-morph's job in `code-graph`.

## Gotchas

**A `.js` file passes the filter and then fails to parse.** The filter registers
`javascript` for `.js` and `.jsx`, but `parseFile` has no JavaScript grammar and rejects
with `Unsupported language: javascript`. This is inherited behaviour, pinned by a test.

**Filter language and parser language are different vocabularies.** `getLanguageFromPath`
returns `typescript` for `.tsx`, but JSX parses without errors only under the `tsx`
grammar. Pick the grammar from the extension, not from the filter's answer.

**`web-tree-sitter` is a peer.** `ParsedFile.tree` is its `Tree`, and you will walk it with
its `Node` type, so there must be exactly one copy. The grammar packages are regular
dependencies and resolve relative to this package, so pnpm's strict layout and npm's flat
one both work. Their native install scripts are unused.

## Where it came from

Extracted from `@titan-design/code-graph` (TP-125), which had ported it unchanged from
codewatch's `@codewatch/core` (`parser/parser.ts`, `parser/types.ts`,
`ingest/file-filter.ts`). Split out so the style-analyzer port (TP-134) can parse without
inheriting ts-morph and the SQLite graph store.
