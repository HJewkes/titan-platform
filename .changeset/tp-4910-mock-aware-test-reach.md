---
"@titan-design/code-graph": minor
---

Mock-aware test reach (TP-4910). The TypeScript extractor records a `mocks` edge from a file to each module a static `vi.mock` / `jest.mock` specifier resolves to, and `INDEX_VERSION` moves to 0.33.0 so existing snapshots re-extract. New `testsReachingMasked` and `fileTestReach` skip a test's hops into modules its own mocks replace, while another test's real import still counts and `require()` hops stay live. A file with more than `MOCK_MASK_CAP` mocks flows unmasked and is listed in `unmasked` with the reason. PageRank gives `mocks` edges no weight.
