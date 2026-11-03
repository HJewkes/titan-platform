---
"titan-console": patch
---

Make the inbox fast on a live spool (TP-4754). `inbox.prepare` and `inbox.act` now share the inbox's kept needs.list read instead of reading the factory again, and skip the lineage read, which no tap checks. A factory relay frame marks the kept reads stale instead of dropping them, so the next read is served at once while one refresh runs behind it. Gate strips and merge-row lineage are served from a kept read past their window while one refresh runs behind, a kept strip is rebuilt from the live Shepherd row so a new hold shows at once, and the default view reads no strip or lineage for a planning row it shows collapsed.
