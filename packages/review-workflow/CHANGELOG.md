# @titan-design/review-workflow

## 0.1.0

### Minor Changes

- 6f1c6b9: Add the workflow fixer: `fixerFingerprint`, `fixerName` (one fixer per fingerprint across PRs), the propose-only `fixerBrief`, `requestFixer` that parks a run as `needs-fixer`, `resolveFingerprint`, and the `FIXER-REPORT` parser `readFixerReport` (TP-3921).
- fa60411: Add the heals: `refresh-checkout`, `degrade-headroom`, `retarget` and `await-account` (`applyHeal`), and `healOnce`, which runs one heal pass and re-decides once; an ineffective heal returns `fixer(heal-ineffective)` (TP-3922).
- f325826: Add the review-workflow package: its ports, step ids, outcome union, failure classes and `DEFAULT_RETRY_POLICY` as data (TP-3920).

### Patch Changes

- Updated dependencies [581c26f]
- Updated dependencies [83a5759]
- Updated dependencies [c15f0dc]
- Updated dependencies [5f2d9ed]
- Updated dependencies [d3d9a04]
- Updated dependencies [123f2d0]
- Updated dependencies [dcaebb9]
- Updated dependencies [24f1577]
- Updated dependencies [a20c348]
- Updated dependencies [c18be57]
- Updated dependencies [44038c9]
- Updated dependencies [7d3b5fb]
- Updated dependencies [481f3e4]
- Updated dependencies [801f9c4]
- Updated dependencies [52dc7f3]
- Updated dependencies [12afa80]
- Updated dependencies [d130bd8]
- Updated dependencies [cb470f4]
- Updated dependencies [7012bf0]
  - @titan-design/github@0.12.0
  - @titan-design/review-panel@0.9.0
  - @titan-design/agent-dispatch@0.10.0
