---
"@titan-design/session-analytics": patch
---

Price `claude-opus-5-5` and `claude-sonnet-5-5` from their own rows, and match a model prefix only at a model-id boundary so `claude-opus-5` no longer prices `claude-opus-5-5` and an unlisted `claude-opus-5-9` is unpriced. `PRICE_TABLE_VERSION` is 2.
