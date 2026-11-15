---
"@titan-design/retrieval-eval": minor
---

Add a `hybrid-bge-small` candidate that fuses notes-fts with the local `Xenova/bge-small-en-v1.5` embedder at RRF k=60, and accept `--embedder local` for `hybrid-fts-vector`. An unknown `--embedder` value now fails before any pairs are read. `hybridVector` takes a `name` option; the existing arm keeps `hybrid-fts-vector`.
