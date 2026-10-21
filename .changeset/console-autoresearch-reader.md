---
"titan-console": minor
---

Add the autoresearch daemon reader: `autoresearch.runs`, `autoresearch.run` and `autoresearch.diff` proxy titan-factory's read model on loopback, strip fields the page does not pin, and answer an error envelope when the factory is down. The `#/autoresearch` page now loads through them, and the synthetic run lives only in the twin.
