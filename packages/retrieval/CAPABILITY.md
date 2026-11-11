# retrieval: use this when

<!-- One to three sentences for a reader deciding whether to reuse this or build something new. Feeds CAPABILITIES.md. -->

You need search over a store-sqlite corpus that fuses FTS, vectors and graph hops and keeps answering when one retriever is down. `fuseByRRF` and `gatherFailOpen` work over your own retrievers too. `engine.retrieve` takes one zod-validated request: `mode: "list"` is `search`, and `mode: "context"` turns the same ranking into a token-budgeted, tiered context block via `planContext`.
