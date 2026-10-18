# agent-protocol: use this when

<!-- One to three sentences for a reader deciding whether to reuse this or build something new. Feeds CAPABILITIES.md. -->

You need harness-neutral identity, execution-phase or usage types, or `foldUsage` to deduplicate deltas and snapshots. For canonical zod-validated execution trace records with a privacy redactor, import `./trace`. For existing dated catalog matching and cost arithmetic, import `./pricing`: `findPrice`/`priceRequest` preserve Claude cache TTL and long-prompt policy, while `priceCodexUsage`/`validateCodexPrices` preserve supplied-row inclusive-token accounting without native accounts, runtime price fetches or stored-cost rewrites.
