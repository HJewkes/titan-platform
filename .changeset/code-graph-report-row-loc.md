---
"@titan-design/code-graph": minor
---

Add `loc` to `HotspotRow` and `UnusedExportRow`, matching codewatch's graph report. `topHotspots` reads the file `loc` metric and `topUnusedExports` reads `symbol_loc`; both give 0 when unmeasured, and drift's `newHotspots` carry it through. No index contents change, so `INDEX_VERSION` stays.
