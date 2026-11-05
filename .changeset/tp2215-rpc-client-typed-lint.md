---
"@titan-design/rpc-client": patch
---

Clear the typed-lint baseline for rpc-client: narrow parsed snapshots and envelopes instead of casting them. `parseSnapshot` now returns a validated copy rather than the parsed object itself.
