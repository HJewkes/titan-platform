# code-parser

**Tier 0 · primitives.** No titan dependencies. Peer: `web-tree-sitter`.

```sh
npm install @titan-design/code-parser web-tree-sitter@^0.26.6
```

## The problem it solves

Tree-sitter parsing in Node needs three fiddly things done once: initialise the WASM
runtime, find each grammar's `.wasm` file inside an installed package, and cache one parser
per language. Code analyzers also need to agree on which files count as source and on the
shape of a parsed file. They also need to count complexity the same way. This package owns
those five pieces: `parseFile`, the file filter, `ParsedFile`, the `Extractor<T>` contract,
and the complexity kinds.

The complexity kinds are `cyclomaticOf(body, language)`, which returns McCabe complexity (one
plus every branch node and boolean operator under `body`), and `nestingDepthOf(node, language,
depth?, options?)`, which returns the deepest nesting level under `node`. Four node-type sets
drive them: `TS_BRANCH_TYPES`, `PY_BRANCH_TYPES`, `TS_NESTING_TYPES` and `PY_NESTING_TYPES`.
`nestingDepthOf` takes `NestingOptions`; with `flattenElseIf: true` an `else if` chain stays at
its `if`'s depth, as ESLint max-depth and Sonar count it.

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

**`.tsx` is `typescript` to the filter and `tsx` to the grammar.** `getLanguageFromPath`
returns `typescript` for `.tsx`, and `parseFile` picks the `tsx` grammar from the extension,
so passing the filter's answer straight through parses JSX cleanly. `ParsedFile.language`
stays `typescript`. codewatch and the first port parsed `.tsx` with the TypeScript grammar,
which turned most JSX files into error trees (TP-166).

**`.js` and `.jsx` are not source.** The filter used to accept them as `javascript`, and
`parseFile` then rejected them. Now `getLanguageFromPath` returns `null` for them and
`shouldIncludeFile` returns `false`, so a walk skips them without throwing.

**Bare `&` in JSX text is still an error.** The tsx grammar rejects a bare `&` or a numeric
entity like `&#128196;` in JSX text, so those files keep `hasError` set.

**`web-tree-sitter` is a peer.** `ParsedFile.tree` is its `Tree`, and you will walk it with
its `Node` type, so there must be exactly one copy. The grammar packages are regular
dependencies and resolve relative to this package, so pnpm's strict layout and npm's flat
one both work. Their native install scripts are unused.

## Where it came from

Extracted from `@titan-design/code-graph` (TP-125), which had ported it unchanged from
codewatch's `@codewatch/core` (`parser/parser.ts`, `parser/types.ts`,
`ingest/file-filter.ts`). Split out so the style-analyzer port (TP-134) can parse without
inheriting ts-morph and the SQLite graph store.
