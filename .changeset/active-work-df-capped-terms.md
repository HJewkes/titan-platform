---
"@titan-design/active-work": patch
---

Class-scoped span search no longer ORs common words into its query. FTS5 ranks every match before the class filter applies, so words like `agent` or `now` made each bootstrap and `context related` query rank most of the corpus. `deriveQuery` and the bootstrap note ranking now drop terms that match more than 1% of spans (never below 2,000), keeping the three rarest when fewer clear the cap. Document frequency is read from the FTS5 vocabulary for common terms and counted exactly for rare ones.
