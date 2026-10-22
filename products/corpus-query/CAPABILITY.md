# corpus-query: use this when

<!-- One to three sentences for a reader deciding whether to reuse this or build something new. Feeds CAPABILITIES.md. -->

You need to answer "list every X" over a large local text corpus without feeding the corpus to a model. `corpus-query index <root>` builds a per-user paragraph index: `indexCorpus` walks the files, `CorpusLayout` (`archiveLayout`, `plainLayout`) names and orders each document, `parseHeader` reads its `KEY: value` header, and `splitParagraphs` gives UTF-8 byte ranges that `SpanFtsTables` indexes contentlessly, so the index holds tokens and locators but no prose and `readSpanText` re-reads a paragraph from its file. A re-run re-indexes only files whose sha-256 changed. `QuerySpecSchema` is the shape of a compiled question. Retrieval, the judge calls and rendering are not here yet; ranked search over embeddings is `retrieval`, and the span index itself is `store-sqlite`.
