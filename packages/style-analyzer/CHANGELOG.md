# @titan-design/style-analyzer

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
