---
"@titan-design/code-graph": minor
---

The TS extractor now emits an `imports` edge, marked `attrs.require: true`, for each static `require()` of an in-repo relative module, so CommonJS-loaded modules have inbound edges. `fileTestReach` keeps those hops live under a test's `vi.mock`, since a mock replaces only what `import` loads. Extreme mutation's outside-suite reach now goes through `fileTestReach`, so a test that mocks a module no longer counts as reaching it. `INDEX_VERSION` is 0.34.0: existing snapshots are not reused and the next index is a full one.
