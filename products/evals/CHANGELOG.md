# @titan-design/evals

## 0.5.1

### Patch Changes

- Updated dependencies [6aa69f2]
  - @titan-design/fix-proof@0.6.0
  - @titan-design/review-panel@0.6.1

## 0.5.0

### Minor Changes

- 2074f2f: TP-1144a: add the shared implement-task case writer. `writeImplementTaskCases` turns an accepted pull request into a private `titan.case/v1` for the new `units/implement-task` unit: the merge's first-parent tree under `trees/<id>` (no `.git`), hidden tests and carried support files from `@titan-design/fix-proof` `planFixProof` under `hidden/<id>`, each listed with path, sha256 and source PR. Private sources are filtered before writing and asserted absent before the first write. `seedWorkspace` makes a one-commit repo from a base tree, and `assertNoLaterHistory` refuses one that holds more. The out-dir guards move to `private/out-dir.ts`, and `bundle.ts` exports `archiveInto` and `verifyCommit`.
- b9147da: TP-689a: add the trial host. `createTrialHost` runs one variant on one case in a workflow runtime over the trial's own SQLite file, with one route per variant step: `code` steps run the topology's in-process implementation, `agent` and `llm` steps go through an injected launch port, and `gate` and `unit` steps are refused by name. The trial record holds every attempt, a call per `tool_use` block, and cost and tokens from the launch's usage. A session that ran a model other than the step's fails the trial, and `rate_limited`, `auth_misconfigured` and `runtime_error` mark it `infra`. `createTrialHost` and its record types are exported; slice b adds resumable runs.
- 11e79ae: TP-689b: add resumable trial runs. `runTrials` runs variants × cases × trials one at a time, each in `runDir/<trialId>/` with its own trial file, workspace and `CLAUDE_CONFIG_DIR`, and writes `record.json` atomically when the trial settles. Run it again with the same run id to resume: settled trials are read back, a trial with only a trial file is hydrated, and the rest start. An `infra` trial runs once more from a cleared sandbox, and a run parked for recovery after a crash now counts as `infra`. `agentRoute` binds the launch port to a trial's sandbox over `runAgent`, or an injected launch. `createTrialHost` gains `resume`.

### Patch Changes

- fa57812: TP-1144d: add the implement-task corpus selector. `parseCorpusV3` reads v3 corpus rows with a loose schema and refuses a malformed line by number. `selectCandidates` skips a row with one reason (`private-repo`, `class-not-requested`, `tangled`, `brief-leak`, then from clone facts `unsupported-runner`, a two-parent merge as `tangled`, `test-only` and `no-test-change`) and orders each requested class by a seeded hash. Not yet exported; the slice e export calls it.
- 9abae48: Reviewers run no tests: the default reviewer test rule, now exported as `CI_REVIEWER_TEST_RULE`, has them cite the CI check-runs (name and conclusion) at the reviewed head and treat a missing, running or red required check as blocking. Shepherd uses it on every host, and its fixer rules name `pnpm test:affected` (TP-1727 slice 3). The review-pr eval's offline trial brief swaps in its own no-CI test rule.
- Updated dependencies [108b7f4]
- Updated dependencies [9f24b7f]
- Updated dependencies [cd013d1]
- Updated dependencies [089ac2c]
- Updated dependencies [7b9baf5]
- Updated dependencies [f171698]
- Updated dependencies [30c7ab5]
- Updated dependencies [8a027ad]
- Updated dependencies [9abae48]
- Updated dependencies [cf7c870]
- Updated dependencies [b0a3f7b]
- Updated dependencies [ed7042a]
- Updated dependencies [79754af]
- Updated dependencies [a79cffd]
- Updated dependencies [eae2dc4]
- Updated dependencies [2503c0c]
- Updated dependencies [fe65aaa]
- Updated dependencies [91ea294]
- Updated dependencies [dfffc6c]
- Updated dependencies [ca49f58]
- Updated dependencies [2ea3f8a]
- Updated dependencies [59131da]
- Updated dependencies [62adbb2]
- Updated dependencies [adfec4b]
- Updated dependencies [adfec4b]
- Updated dependencies [c2d805b]
- Updated dependencies [336aaf2]
- Updated dependencies [e22d2fd]
- Updated dependencies [cbc3107]
- Updated dependencies [4ba57bf]
- Updated dependencies [7499737]
- Updated dependencies [069c3b2]
- Updated dependencies [7dbe2bb]
- Updated dependencies [d754d5b]
- Updated dependencies [ba8f25e]
- Updated dependencies [ba8f25e]
- Updated dependencies [15b5395]
- Updated dependencies [462e693]
- Updated dependencies [c0bdde5]
- Updated dependencies [4ec603a]
- Updated dependencies [c4fc339]
- Updated dependencies [29e51f1]
- Updated dependencies [4dc300d]
- Updated dependencies [ac8bf42]
- Updated dependencies [5f5dce9]
- Updated dependencies [7a47bb3]
- Updated dependencies [7d93a92]
- Updated dependencies [edcb589]
- Updated dependencies [5cd4f1b]
- Updated dependencies [abadd64]
- Updated dependencies [abadd64]
- Updated dependencies [b6072b5]
- Updated dependencies [d79a135]
- Updated dependencies [6b222d0]
- Updated dependencies [1b2c974]
- Updated dependencies [ef109f3]
- Updated dependencies [a2e2a70]
- Updated dependencies [dbc8a21]
- Updated dependencies [45d312c]
- Updated dependencies [1c956dd]
- Updated dependencies [f03dea7]
- Updated dependencies [811e8ac]
- Updated dependencies [55cdd43]
- Updated dependencies [2467880]
- Updated dependencies [fa23feb]
- Updated dependencies [31a7c73]
- Updated dependencies [2892aad]
- Updated dependencies [d79f48e]
  - @titan-design/agent@0.6.0
  - @titan-design/review-panel@0.6.0
  - @titan-design/workflow@0.13.0
  - @titan-design/session-analytics@0.17.0
  - @titan-design/authority@0.5.0
  - @titan-design/fix-proof@0.5.0
  - @titan-design/session-read@0.15.0
  - @titan-design/evidence@0.3.0
  - @titan-design/hitl@0.9.0

## 0.4.0

### Minor Changes

- 913bb9a: TP-691b: add `titan-evals review-pr cases`, the private case builder for the `review-pr` unit. It turns outcome-corpus rows into private cases, with caught heads as FIX_FIRST plus the defect path and each PR's final clean head as MERGE. It plants six seeded controls (a deleted assertion, an inverted condition, a test that no longer bites) as tree fixtures with a gold path and line. It writes the cases, a suite with the review-pr checks, and a manifest to an empty out dir outside any git work tree, and the private exclusion runs before anything is written.

### Patch Changes

- Updated dependencies [de21f12]
- Updated dependencies [cd01cfa]
  - @titan-design/session-analytics@0.16.0

## 0.3.1

### Patch Changes

- Updated dependencies [b60d484]
- Updated dependencies [7b9335c]
  - @titan-design/review-panel@0.5.3
  - @titan-design/session-read@0.14.0
  - @titan-design/session-analytics@0.15.1

## 0.3.0

### Minor Changes

- 84faee5: TP-691a: ship the `review-pr` unit and its `live-brief` variant under `units/review-pr/`, plus three building blocks for the private case builder. `reviewPrBrief` renders the live `reviewerBrief` with only its checkout lines swapped for bundle paths. `materializeBundle` writes `head/`, `base/` (via `git archive`, no `.git`) and `diff.patch` from a local clone through a git-only port. `private/exclusion` ports F6's three-layer private exclusion (allowlist, markers read from an active-work root, final assertion) with a self-test.

### Patch Changes

- Updated dependencies [f640f72]
- Updated dependencies [3ecb1c7]
  - @titan-design/session-analytics@0.15.0
  - @titan-design/session-read@0.13.2

## 0.2.5

### Patch Changes

- Updated dependencies [11df74d]
- Updated dependencies [662f42b]
- Updated dependencies [b924847]
  - @titan-design/session-analytics@0.14.0
  - @titan-design/session-read@0.13.1

## 0.2.4

### Patch Changes

- Updated dependencies [7c73654]
  - @titan-design/session-read@0.13.0
  - @titan-design/review-panel@0.5.1
  - @titan-design/session-analytics@0.13.2

## 0.2.3

### Patch Changes

- Updated dependencies [587f2de]
- Updated dependencies [3d3cc58]
- Updated dependencies [3d3cc58]
  - @titan-design/session-analytics@0.13.0
  - @titan-design/review-panel@0.5.0
  - @titan-design/session-read@0.12.2

## 0.2.2

### Patch Changes

- Updated dependencies [1add3c6]
  - @titan-design/review-panel@0.4.0

## 0.2.1

### Patch Changes

- Updated dependencies [be6e34c]
  - @titan-design/session-analytics@0.12.0

## 0.2.0

### Minor Changes

- 19fa0ef: Add the review outcome corpus: `titan-evals corpus` and `buildCorpus` write one row per reviewed head from the factory database, opened read-only, and git history, with the revert, main-red, later-fix, owner-override and fixer-changed-cited-paths labels and a derived escaped, caught, false-block, clean, pending or unresolved label.

### Patch Changes

- Updated dependencies [3bf2ac3]
- Updated dependencies [d7102a6]
- Updated dependencies [73683d7]
- Updated dependencies [7d52415]
- Updated dependencies [446c60a]
- Updated dependencies [5c659a3]
- Updated dependencies [dcf8e04]
  - @titan-design/session-read@0.12.0
  - @titan-design/session-analytics@0.11.0
  - @titan-design/review-panel@0.3.0

## 0.1.1

### Patch Changes

- d8ea373: Record the resolved champion hash in a new `titan.trial/v1` record and carry it into the scorecard key, so trials against different champions never share a key.
- 83588c9: Accept an exact model id with a final `[1m]` suffix, so a 1M-context variant can be registered. Vertex (`@`) and Bedrock (`:`) id forms are accepted too; bare aliases, mixed case, spaces and `-latest` are still refused.

## 0.1.0

### Minor Changes

- df4102e: Add the evals product scaffold: spec schemas for unit, variant, case, suite, check and scorecard with strict and loose parsing, canonical content hashing that covers referenced prompt files, a `titan-evals validate` command, and one synthetic fixture unit.
