# @titan-design/style-analyzer

## 0.1.5

### Patch Changes

- b2b440c: Fix misclassifications in the formatting, error-handling and structure extractors.

  - `.editorconfig` parsing reads only the `[*]` section, so a later `[Makefile]` section no longer overrides the project-wide indent style. It skips `;` comments and drops a non-numeric `indent_size`.
  - `extractFromConfig` reads only JSON `.prettierrc` and `.prettierrc.json`; it no longer hands `prettier.config.*` or YAML `.prettierrc.*` files to `JSON.parse`.
  - `custom-error-class` requires a base class whose name ends in `Error` or `Exception`, so `extends ErrorBoundary` no longer counts.
  - `result-type` matches a return-type identifier exactly, so `Promise<SearchResult>` no longer counts.
  - Unprefixed Node builtins such as `fs` and `fs/promises`, and every Python 3.12 stdlib module such as `asyncio`, classify as `builtin` imports.

- Updated dependencies [5b07edd]
  - @titan-design/style-profile@0.4.1

## 0.1.4

### Patch Changes

- 9e66a85: Fix two source formatting heuristics. Statements and blocks closing a block body no longer count as missing trailing commas, so ordinary trailing-comma code reports `trailingCommas: true`. Comment lines no longer feed the indent-size estimate, so a file with a top-level JSDoc block no longer reports `indentSize: 1`.

## 0.1.3

### Patch Changes

- 71e0d20: `AI_ENRICHED_FEATURES` now names the seven feature types the extractors emit (`documentation.comment-placement`, `documentation.inline-comment`, `documentation.jsdoc-tag`, `error-handling.catch-specificity`, `structure.export-style`, `reviewVoice.topicFrequency`, `reviewVoice.keyword`). Before, it named ten types nothing emitted, so `Enricher.enrich` built no jobs on real extractor output.
- d4c2741: `mapSeverity` is now style-profile's `severityForConfidence`, so the analyzer and the exporters share one ladder.
- Updated dependencies [bbb4821]
- Updated dependencies [d4c2741]
  - @titan-design/style-profile@0.4.0

## 0.1.2

### Patch Changes

- Updated dependencies [8003e54]
  - @titan-design/style-profile@0.3.0

## 0.1.1

### Patch Changes

- Updated dependencies [89da3cf]
  - @titan-design/style-profile@0.2.0

## 0.1.0

### Minor Changes

- 0922be1: Add the rest of codewatch's analyzer, ported unchanged: `Aggregator` with
  `computeConfidence`, `mapSeverity` and `lookupStability`; the `Enricher` with
  `AI_ENRICHED_FEATURES` and `needsAiEnrichment`, running against an injected `LlmProvider`;
  and the ingest corpus types. `zod` v4 is now a peer dependency, because style-profile needs
  it at runtime.
- 95fc0d6: New package `@titan-design/style-analyzer` (tier 2), ported unchanged from codewatch's
  analyzer: the nine tree-sitter style extractors (`NamingExtractor`, `StructureExtractor`,
  `ControlFlowExtractor`, `DocumentationExtractor`, `ErrorHandlingExtractor`,
  `FormattingExtractor`, `ComplexityExtractor`, `IdiomsExtractor`, `ReviewVoiceExtractor`),
  `createStyleExtractors`, and the `Observation`, `ObservationCategory`, `StyleExtractor` and
  deprecated `Extractor` types. `web-tree-sitter` is a peer dependency.

### Patch Changes

- 94fdafc: Fix two bugs inherited from codewatch's analyzer. Both change aggregated output.

  - `STABILITY_MAP` is now keyed by the observation types the extractors actually emit
    (TP-172). The old keys used taxonomy spellings such as `naming.variables`,
    `controlFlow.guardClauses` and `errorHandling.tryCatchFrequency`. Thirty of the 49
    emitted types matched no key and fell back to `medium`. Fourteen of them are now `high`,
    so their confidence is `consistency` instead of `consistency * 0.85`, and their severity
    can rise. They are `naming.variable`, `.function`, `.type`, `.constant`, `.enum` and
    `.private-member`; `control-flow.guard-clause`, `.array-method` and `.async-await`;
    `documentation.jsdoc-presence`; and `error-handling.try-catch`, `.result-type`,
    `.exhaustive-switch` and `.assert-never`. The other sixteen keep `medium`: thirteen have
    an explicit `medium` rating now, and three are listed as unrated on purpose. Keys
    that no extractor emits were removed.
  - Python capitals assignments at module scope are now classified as `naming.constant`
    instead of `naming.variable` (TP-173). Module scope means top level, or inside a
    module-level `if`, `elif`, `else`, `try`, `except`, `finally` or `with` block, so
    `try: HAS_LZMA = True / except: HAS_LZMA = False` counts. Annotated and chained
    assignments count too. Class, function and loop bodies do not.
  - In both TypeScript and Python, a single capitalised word of two or more characters now
    counts as a constant name. Examples are `DEBUG = True`, `ERROR = 1` and
    `export const VERSION = "1.0.0"`. These used to be reported as `naming.variable`
    `PascalCase`, and are now `naming.constant` `SCREAMING_SNAKE`. A single letter is left out
    on purpose, because in real code it is a TypeVar or ParamSpec (`T = TypeVar("T")`,
    `P = ParamSpec("P")`), so it stays `naming.variable` `PascalCase`. TypeScript `const` at
    any depth counts, as it already did for `SCREAMING_SNAKE` names.

- Updated dependencies [336120d]
- Updated dependencies [39f1512]
- Updated dependencies [e851dbb]
  - @titan-design/code-parser@0.1.0
  - @titan-design/style-profile@0.1.0
