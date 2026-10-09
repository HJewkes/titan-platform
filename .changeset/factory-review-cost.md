---
"@titan-design/factory": minor
---

`titan-factory shepherd stats --cost` reports reviewer dollars and tokens (input, cache read, cache write, output) per merged PR, per repo and ISO week, and in total with p50 and p90 per merged PR. Every dispatched review round counts, from its review intent to the step that resolved it (an on-time, corrected or late verdict, or a timeout); it reads the transcript the round's verdict locator names, read-only, and prices it with `@titan-design/session-analytics` `priceRequest`. A round that cannot be priced is listed as unreadable with its reason and never counted as zero.
