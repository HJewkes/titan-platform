---
"@titan-design/code-graph": minor
---

Add codewatch's test linker, Istanbul coverage overlay and test-coverage ownership, ported unchanged: `linkTestsToSources`, `testCoverageCountMetrics`, `groupTestsBySource`, `attributeCoverage`, `COVERAGE_METRIC_NAME` and `computeTestCoverageOwnership`.

`indexPaths` now writes `linked_test_count` on every source file that a test links to, by path convention or by co-edit history. With git history on it also writes `test_bus_factor_{w}` and `test_top_author_share_{w}` for the primary window. The names match codewatch. `coverage_pct` is not written at index time: `attributeCoverage` turns an Istanbul `coverage-final.json` into metrics for the caller to store on a snapshot.
