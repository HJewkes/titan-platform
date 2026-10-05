---
"@titan-design/style-analyzer": patch
---

`AI_ENRICHED_FEATURES` now names the seven feature types the extractors emit (`documentation.comment-placement`, `documentation.inline-comment`, `documentation.jsdoc-tag`, `error-handling.catch-specificity`, `structure.export-style`, `reviewVoice.topicFrequency`, `reviewVoice.keyword`). Before, it named ten types nothing emitted, so `Enricher.enrich` built no jobs on real extractor output.
