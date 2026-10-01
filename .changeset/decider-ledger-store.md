---
"@titan-design/decider": minor
---

Add the ledger store and sources: `LedgerStore` (append-only by row key, a watermark per source cursor, on store-sqlite), the `LedgerSource` port `{ name, read(since) }`, `extractSource`, which drops excluded rows before writing, and `transcriptSource`, the `AskUserQuestion` source ported from active-work over session-read. The `LedgerSource` type naming a row's source is now `LedgerSourceName`. Scoring changes: a declined (`rejected`) question is unscored rather than `other`, a recommendation marker containing "recommend" is stripped whether prefix, suffix or bracketed, and a negated marker ("not recommended") no longer counts as the recommended option, and exclusion scans option descriptions for personal data.
