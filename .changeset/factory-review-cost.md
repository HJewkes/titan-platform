---
"@titan-design/factory": minor
---

`titan-factory shepherd stats --cost` reports reviewer dollars and tokens (input, cache read, cache write, output) per merged PR, per repo and ISO week, and in total with p50 and p90 per merged PR. It reads the transcripts the verdict locators name, read-only, and prices them with `@titan-design/session-analytics` `priceRequest`. A session that cannot be read is listed as unreadable with its reason and never counted as zero.
