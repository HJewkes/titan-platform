# style-analyzer

**Tier 2.** Depends on `code-parser` (tier 0) and `style-profile` (tier 2). `web-tree-sitter`
and `zod` v4 are peer dependencies.

```sh
npm install @titan-design/style-analyzer web-tree-sitter@^0.26.6 zod
```

## The problem it solves

A style profile is only as good as the evidence behind it. Before this package, the
evidence came from codewatch's analyzer and nowhere else on the platform. This package
provides that evidence: nine extractors that walk a tree-sitter tree and record every style
decision they see as an `Observation` (`type`, `category`, `value`, `file`, `line`,
`metadata`). One observation is one data point, such as "this variable is camelCase" or
"this function has cyclomatic complexity 4". The aggregator then turns thousands of data
points into a profile: for each observation type, the dominant convention, how consistent
the code is about it, and how much to trust that.

## When to reach for it

- You want to measure how a codebase is actually written: naming conventions, import
  grouping, guard clauses, comment density, error handling, formatting, function size.
- You are building a style profile from real code and need the raw data points, or the
  aggregated conventions with confidence and severity.

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
| `Aggregator` | `aggregate(observations)` returns `{ features, reviewQueue, summary }`; config: `stabilityWeights`, `severityThresholds`, `reviewThreshold` (0.6), `maxExamples` (5) |
| `AggregatedFeature`, `AggregatorConfig`, `AggregatorResult`, `FrequencyDistribution` | the aggregator's shapes |
| `computeConfidence(consistency, stability, weights?)` | `min(1, consistency * weight)`, weights high 1.0, medium 0.85, low 0.7 |
| `mapSeverity(confidence, thresholds?)` | `error`, `warn`, `info` or `off`, using style-profile's thresholds |
| `lookupStability(type)`, `Stability`, `StabilityWeights`, `Severity`, `SeverityThresholds` | stability table lookup (exact type, then category, then `medium`) |
| `Enricher`, `EnricherConfig`, `EnrichmentResult`, `EnrichmentEntry`, `EnrichmentError` | LLM descriptions for the ten features in `AI_ENRICHED_FEATURES` |
| `LlmProvider`, `LlmMessage`, `LlmResponse` | the injected "complete this prompt" interface |
| `AI_ENRICHED_FEATURES`, `needsAiEnrichment(type)` | which feature types the enricher describes |
| `IngestConfig`, `CodeCorpus`, `CodeFile`, `ReviewComment`, `PullRequest`, `PullRequestFile`, `IngestMetadata` | corpus types from codewatch's ingestion (types only) |
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

Then a profile out:

```ts
import { Aggregator } from "@titan-design/style-analyzer";

const { features, reviewQueue, summary } = new Aggregator().aggregate(observations);
```

```text
naming.function {"convention":"camelCase","confidence":1,"stability":"high","severity":"error","needsReview":false}
control-flow.guard-clause {"convention":true,"confidence":1,"stability":"high","severity":"error","needsReview":false}
formatting.quoteStyle {"convention":"double","confidence":1,"stability":"high","severity":"error","needsReview":false}
complexity.cyclomatic {"convention":2,"confidence":1,"stability":"high","severity":"error","needsReview":false}
summary {"totalObservations":22,"totalFeatures":22,"avgConfidence":0.9659090909090909,"featuresNeedingReview":0}
```

One file makes every feature perfectly consistent, so confidence here is just the stability
weight. Over a real corpus, consistency falls below 1 and the review queue fills with the
features the code is inconsistent about.

To describe the qualitative features, pass an `LlmProvider` to `Enricher`. The package
README shows a ten-line adapter over `@titan-design/agent`.

## What it deliberately does not do

- It does not fetch code. codewatch's GitHub ingestion (`GitHubService`) was not ported.
- It does not choose or call an LLM itself. The enricher takes an injected `LlmProvider`.
  codewatch's `ClaudeHaikuProvider`, `OllamaProvider` and `createProvider` were not ported.
- It does not compare code against a profile. That is the style checker's job.
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
- A `.tsx` file parses with the `tsx` grammar even when passed as `typescript` (code-parser
  0.1.0, TP-166). codewatch parsed it with the `typescript` grammar, so extractor output for
  `.tsx` files can differ from the original's. Output for `.ts` and `.py` files is identical.
- Review-voice observations carry `file: "_reviews"` and `line: 0`, not a real location.
- `STABILITY_MAP` is keyed by the exact types the extractors emit, and a test fails if an
  emitted type has no entry or an entry names a type nothing emits. Three emitted types
  have no taxonomy rating and take `medium` on purpose: `control-flow.if-else`,
  `.promise-then` and `.else-after-return`. No emitted type is rated `low` today, so the
  0.7 weight is unused.
- A constant name is `SCREAMING_SNAKE` or one capitalised word of two or more characters
  (`DEBUG`, `VERSION`), in both languages. A single letter (`T = TypeVar("T")`,
  `const K = 1`) is left out and reports as `naming.variable` `PascalCase`. A two-letter
  TypeVar such as `KT = TypeVar("KT")` is not left out and counts as a constant.
- In TypeScript, any `const` with a constant name counts, at any depth. In Python, only an
  assignment at module scope counts. That means top level or inside a module-level `if`,
  `elif`, `else`, `try`, `except`, `finally` or `with` block, so
  `try: HAS_LZMA = True / except: HAS_LZMA = False` qualifies. Plain, annotated
  (`TIMEOUT_S: int = 30`) and chained (`A_MAX = B_MAX = 5`) forms all count. Class, function
  and loop bodies do not count, so their capitals report as `naming.variable`. Tuple targets
  and dunders such as `__all__` emit nothing.
- The enricher runs prompts one at a time and checks the budget only before each prompt,
  so the last prompt can overshoot `totalTokenBudget`.

## Where it came from

Ported from codewatch's `packages/analyzer` (TP-134) with behaviour unchanged. A
differential run over 30 TypeScript and 30 Python files produced the same 8,638
observations from both. The aggregated profiles and the enricher's prompts and results
also matched byte for byte. The only source changes are imports, erase-only non-null
assertions for `noUncheckedIndexedAccess`, and splitting long functions into helpers.
Formatting's config parsing now lives in `formatting-config.ts`. The enricher's LLM types
and its sequential, budgeted runner loop came from codewatch's `core/src/llm`.

Two fixes changed behaviour after the port (TP-172, TP-173). `STABILITY_MAP` used to be
keyed by taxonomy spellings such as `naming.variables` and `controlFlow.guardClauses`.
Those keys matched none of the emitted types, so 30 of 49 types fell back to `medium`.
Fourteen of those 30 are now rated `high`, and their confidence is `consistency` instead
of `consistency * 0.85`. Python module-level constants used to report as `naming.variable`
because the check looked at the wrong tree-sitter parent. Single-word capitals such as
`DEBUG` used to report as `PascalCase` variables in both languages.
