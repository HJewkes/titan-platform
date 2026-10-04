---
"@titan-design/code-graph": minor
---

Add the graph report derivations ported from codewatch: `buildReportContext`, `topHotspots`, `hotspotScoreOf`, `topBusFactorRisks`, `busFactorOf`, `topTestCoverageRisks`, `topCentralFiles`, `keepNode`, `lookupMetric`, `computeReportDrift`, and the report row types. Coupling clusters stay in codewatch because they read `git log` at report time.
