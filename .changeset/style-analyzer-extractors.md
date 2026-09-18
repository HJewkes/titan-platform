---
"@titan-design/style-analyzer": minor
---

New package `@titan-design/style-analyzer` (tier 2), ported unchanged from codewatch's
analyzer: the nine tree-sitter style extractors (`NamingExtractor`, `StructureExtractor`,
`ControlFlowExtractor`, `DocumentationExtractor`, `ErrorHandlingExtractor`,
`FormattingExtractor`, `ComplexityExtractor`, `IdiomsExtractor`, `ReviewVoiceExtractor`),
`createStyleExtractors`, and the `Observation`, `ObservationCategory`, `StyleExtractor` and
deprecated `Extractor` types. `web-tree-sitter` is a peer dependency.
