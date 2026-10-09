---
"@titan-design/health": minor
---

Add the append-only sample store and uptime to `@titan-design/health`. `openHealthStore` opens a store-sqlite `health_sample` table, `appendSamples` validates every row and writes a whole tick in one transaction (rows with a `dedupKey` are written once), and `readSamples` and `storeStats` read it back. Nothing deletes, updates or prunes a sample: no export does, and triggers refuse it. `uptime` and the pure `foldUptime` report up, down, unknown and missing epoch-aligned slots separately, with both shares and the gaps; a missing slot is never up.
