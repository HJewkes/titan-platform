---
"@titan-design/session-analytics": patch
---

Add a parity test that runs every context and gap band boundary and a split-less cache write through the `request_cost` view and through `contextBand`, `gapBand` and `priceRequest`, so the TypeScript and SQL copies cannot drift apart unnoticed. `bands.ts` and `price-request.ts` now name their SQL twin.
