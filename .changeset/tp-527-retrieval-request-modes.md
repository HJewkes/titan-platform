---
"@titan-design/retrieval": minor
---

Add `engine.retrieve(request, options)` with one zod request schema, `RetrievalRequestSchema`, discriminated on `mode`. `mode: "list"` returns what `search` returns. `mode: "context"` ranks `limit` results (default 20), loads their renderings through a `TierSource`, and plans them into a token budget with `planContext`. A tier source that throws drops that result as `tier-error` and adds one `tiers` degradation instead of failing the request. `zod` ^4 is now a peer dependency.
