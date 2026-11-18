---
'@titan-design/retrieval-eval': minor
---

Add a `claims` verb that scores claim recall at an equal token budget: each named arm (fts, fts+hash, fts+ollama) packs context for every question, and a required claim counts as present when its quote occurs in the packed text. Quotes too short to check are excluded and counted.
