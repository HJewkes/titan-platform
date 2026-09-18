# @titan-design/style-analyzer

Tree-sitter style extractors. Each one reads a parsed TypeScript or Python file and emits
`Observation` records: one per naming choice, import, branch, comment, function metric, and
so on.

Tier 2 of the titan-platform DAG (TP-134). Depends on `@titan-design/code-parser` (tier 0)
and `@titan-design/style-profile` (tier 2). Ported unchanged from codewatch's
`@codewatch/analyzer`.

```sh
npm install @titan-design/style-analyzer web-tree-sitter@^0.26.6
```

```ts
import { createStyleExtractors, parseFile } from "@titan-design/style-analyzer";

const file = await parseFile(source, "src/users.ts", "typescript");
const observations = createStyleExtractors().flatMap((extractor) => extractor.extract(file));
// { type: "naming.function", category: "naming", value: "camelCase", file: "src/users.ts", line: 3 }
```

## API

- `Observation` is `{ type, category, value, file, line, metadata? }`. `type` is the feature
  (`naming.variable`, `complexity.cyclomatic`), `value` is a string, number or boolean, and
  `line` is 1-based.
- `StyleExtractor` is `Extractor<Observation>` from code-parser. `Extractor` is its
  deprecated alias, kept for compatibility.
- `createStyleExtractors()` returns the canonical nine, in a fixed order: `NamingExtractor`,
  `StructureExtractor`, `ControlFlowExtractor`, `DocumentationExtractor`,
  `ErrorHandlingExtractor`, `FormattingExtractor`, `ComplexityExtractor`, `IdiomsExtractor`,
  `ReviewVoiceExtractor`.
- `FormattingExtractor.extractFromConfig(path)` reads a `.prettierrc` or `.editorconfig`
  from disk. `extractFromSource(text, path)` works on raw text.
- `IdiomsExtractor.extractFromSources([{ path, content, language }])` finds repeated code
  across files with jscpd.
- `ReviewVoiceExtractor.extractFromComments([{ body }])` classifies review comments by
  topic and keyword.
- `parseFile`, `getSupportedLanguages`, `shouldIncludeFile` and `getLanguageFromPath` are
  re-exported from code-parser, as the original re-exported them from `@codewatch/core`.

## Dependencies

`web-tree-sitter` is a peer dependency, for the same reason code-parser makes it one:
`ParsedFile.tree` is a web-tree-sitter `Tree`, and the extractors walk it with that
package's `Node` type, so the parser and the extractors must see one copy. This package
imports it for types only. `@jscpd/core` 3.5.10 and `@jscpd/tokenizer` 3.5.4 stay pinned
at the original's versions.

## Gotchas

- `IdiomsExtractor.extract` and `ReviewVoiceExtractor.extract` return `[]`. Their real
  inputs are a set of sources and a list of review comments, not one parsed file.
- `FormattingExtractor` works on text with regular expressions, so it also reports
  semicolons and quote style for Python files.
- `extractFromConfig` swallows every error, including a missing file or malformed JSON,
  and returns `[]`.
- Review-voice observations use `file: "_reviews"` and `line: 0`.

The worked example and the full observation list are in the site reference page,
`site/reference/style-analyzer.md`.
