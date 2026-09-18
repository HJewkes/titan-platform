# style-analyzer

**Tier 2.** Depends on `code-parser` (tier 0) and `style-profile` (tier 2). `web-tree-sitter`
is a peer dependency.

```sh
npm install @titan-design/style-analyzer web-tree-sitter@^0.26.6
```

## The problem it solves

A style profile is only as good as the evidence behind it. Before this package, the
evidence came from codewatch's analyzer and nowhere else on the platform. This package
provides that evidence: nine extractors that walk a tree-sitter tree and record every style
decision they see as an `Observation` (`type`, `category`, `value`, `file`, `line`,
`metadata`). One observation is one data point, such as "this variable is camelCase" or
"this function has cyclomatic complexity 4".

## When to reach for it

- You want to measure how a codebase is actually written: naming conventions, import
  grouping, guard clauses, comment density, error handling, formatting, function size.
- You are building a style profile from real code and need the raw data points.

Parsing lives in `code-parser`. Exporting a finished profile to ESLint, ruff and the other
formats lives in `style-profile`.

## Public API

| Export | What it does |
|---|---|
| `Observation`, `ObservationCategory` | the record every extractor emits, and its categories: the profile categories plus `control-flow`, `error-handling`, `reviewVoice`, `idioms`, `complexity` |
| `StyleExtractor`, `Extractor` (deprecated alias), `ParsedFile` | `StyleExtractor` is code-parser's `Extractor<Observation>` |
| `createStyleExtractors()` | the canonical nine extractors, in a fixed order |
| `NamingExtractor` | `naming.variable`, `.function`, `.type`, `.enum`, `.parameter`, `.constant`, `.boolean`, `.private-member` |
| `StructureExtractor` | `structure.import-group`, `.import-order`, `.export-style`, `.export-proximity`, `.barrel-file` |
| `ControlFlowExtractor` | `control-flow.ternary`, `.if-else`, `.guard-clause`, `.else-after-return`, `.for-loop`, `.for-of`, `.for-in`, `.array-method`, `.promise-then`, `.async-await` |
| `DocumentationExtractor` | `documentation.jsdoc-presence`, `.jsdoc-tag`, `.public-coverage`, `.private-coverage`, `.inline-comment`, `.comment-placement` |
| `ErrorHandlingExtractor` | `error-handling.try-catch`, `.catch-specificity`, `.custom-error-class`, `.result-type`, `.assert-never`, `.exhaustive-switch` |
| `FormattingExtractor` | `formatting.semicolons`, `.quoteStyle`, `.trailingCommas`, `.braceStyle`, `.indentStyle`, `.indentSize`; plus `.trailingNewline` from `extractFromConfig(path)` |
| `ComplexityExtractor` | `complexity.fileLength`, `.functionLength`, `.nestingDepth`, `.cyclomatic` |
| `IdiomsExtractor` | `idiom.clone` from `extractFromSources(sources)`, using jscpd |
| `ReviewVoiceExtractor` | `reviewVoice.topicFrequency`, `.keyword` from `extractFromComments(comments)` |
| `parseFile`, `getSupportedLanguages`, `shouldIncludeFile`, `getLanguageFromPath` | re-exported from `code-parser` |

## Example

Verified against 0.1.0. One TypeScript file in, observations out:

```ts
import { createStyleExtractors, parseFile } from "@titan-design/style-analyzer";

const source = `import { readFile } from "node:fs/promises";

export async function loadUser(userId: string) {
  if (!userId) return null;
  const raw = await readFile(\`users/\${userId}.json\`, "utf8");
  return JSON.parse(raw);
}
`;
const file = await parseFile(source, "src/users.ts", "typescript");
const observations = createStyleExtractors().flatMap((e) => e.extract(file));
```

`observations` holds 22 records. Shown as `type value line metadata`:

```text
naming.function "camelCase" line 3
naming.parameter "camelCase" line 3
naming.variable "camelCase" line 5
structure.import-group "builtin" line 1 {"source":"node:fs/promises"}
structure.import-order "[\"builtin\"]" line 1 {"groupCount":1}
structure.export-style "named" line 3
structure.export-proximity "inline" line 3
control-flow.if-else true line 4
control-flow.guard-clause true line 4
control-flow.async-await true line 5
documentation.jsdoc-presence false line 3
documentation.public-coverage false line 3
formatting.semicolons true line 1 {"source":"frequency"}
formatting.quoteStyle "double" line 1 {"source":"frequency"}
formatting.trailingCommas false line 1 {"source":"frequency"}
formatting.braceStyle "1tbs" line 1 {"source":"frequency"}
formatting.indentStyle "space" line 1 {"source":"frequency"}
formatting.indentSize 2 line 1 {"source":"frequency"}
complexity.fileLength 6 line 1
complexity.functionLength 3 line 3 {"functionName":"loadUser"}
complexity.nestingDepth 1 line 3 {"functionName":"loadUser"}
complexity.cyclomatic 2 line 3 {"functionName":"loadUser"}
```

## What it deliberately does not do

- It does not fetch code. codewatch's GitHub ingestion (`GitHubService`) was not ported.
- It adds no detectors beyond the original's. New ones, such as comment bloat or
  defensive-code density, will extend these extractors after the port.

## Gotchas

- `IdiomsExtractor.extract` and `ReviewVoiceExtractor.extract` return `[]`. Call
  `extractFromSources` and `extractFromComments` instead.
- `FormattingExtractor` uses regular expressions over raw text. It reports semicolons and
  quote style for Python files too.
- `extractFromConfig` returns `[]` on any error, including a missing file or bad JSON.
- `NamingExtractor` only handles the languages `typescript`, `tsx` and `python`. Any other
  `ParsedFile.language` yields no naming observations.
- The file filter maps `.tsx` to `typescript`, but a `.tsx` file only parses cleanly with
  the `tsx` grammar. Pass `"tsx"` to `parseFile` yourself (see code-parser's gotchas).
- Review-voice observations carry `file: "_reviews"` and `line: 0`, not a real location.

## Where it came from

Ported from codewatch's `packages/analyzer` (TP-134) with behaviour unchanged. A
differential run over 30 TypeScript and 30 Python files produced the same 8,638
observations from both. The only source changes are imports, erase-only non-null
assertions for `noUncheckedIndexedAccess`, and splitting long functions into helpers.
Formatting's config parsing now lives in `formatting-config.ts`.
