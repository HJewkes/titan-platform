# @titan-design/evals

## 0.6.0

### Minor Changes

- 1bef60b: Replay review-workflow cases through `reviewWorkflow` under policy variants: `replayCase`, `replaySuite` and `scoreReplay`, which counts a FIX_FIRST as a hit only when a verified citation names the case's path. Ships the TP-1929 seed cases and the failure-fixture suite, run in CI over fake ports with no model.
- 860784b: Score review-workflow replay results per variant with `reviewScorecard`, and accept or reject a candidate with `compare(candidate, incumbent)`. A retry or timing change is judged on the failure fixtures alone: no new loop, no fewer verdicts, no more sessions per head. A plan change is judged on catch and cost. Seed cases are a floor on both tracks.
- fe87036: The implement-task selector now accepts npm repos: `hasPnpmLock` became `hasSupportedLock`, true for `pnpm-lock.yaml` or `package-lock.json` at the base. New `cloneFacts(gitFor)` answers the selector's lockfile, merge-parent and test-change questions from a clone with git and the fix-proof plan. `briefOf` and `planHiddenTests` are exported.
- 1d2d520: TP-1144e2: add the implement-task export orchestrator. `exportImplementTaskCases` selects candidates, filters private ones, screens each class in seeded order until `perClass` fills or the pool ends, then writes the kept cases, `suite.json` (`implement-task-private`, `checks: []`) and `manifest.json`, and removes `.scratch` even on a throw. `selectExportPool` is the selection step alone.
- 1dda35e: TP-1144e3: add `titan-evals implement-task export`, with `--dry-run` (select only), `--max-candidates`, `--owner`, `--selftest` and the flags of `review-pr cases`.

### Patch Changes

- e5158bd: Add `titan-evals history build` and `history v2-parity`. `build` lists merged PRs from the session graph, computes each one's git facts from local bare mirrors, applies the private exclusion and writes canonical `cases.jsonl` and a per-repo `summary.json` outside every work tree; it calls no GitHub API. `v2-parity` recomputes label v2 from a gh-cache window and exits 1 on any mismatch (TP-949).
- 5f1ec1f: Add bare PR mirrors with `refs/pull/*/head` and per-PR commit facts (base, start, head and merge shas, paths, test paths, size band) for the history corpus.
- cd2e635: Each `explainer.<stage>` child run ends with a `checks:<stage>` step that runs the stage's deterministic checks; every verdict carries `gate`, a failed gate fails the stage, and reported checks only show in the run report's new Checks table. `bridge.json` `check` commands take `gate` (default `true`). `explainer stage --json` prints the record, verdicts included, even when a gate failed. Adds the `explainer-video` and per-stage ev units with frozen, sha-only cases.
- 7dc68a3: Add `src/history/graph.ts`: `openGraph(path)` opens the session graph read-only and `mergedPrs({ repos, until })` lists merged PRs from allowlisted repos (case-insensitive) merged at or before `until`, sorted by repo then number. First slice of the eval corpus history builder (TP-949).
- 63bbf5a: Add `src/history/label-v2.ts`, a port of the eval corpus label v2 rule (rework commits, prior attempts, follow-up fixes, reverts, outcome, exclusions and the pinned window), an offline `gh-cache` reader that never fetches, and `v2Parity`, which lists each stored case and label field the port disagrees on (TP-949 slice d). Not wired into the CLI yet.
- 3c6ccec: `titan-evals review-pr cases` skips a corpus row whose head, or next head, the local clone no longer holds, and counts it as `head-unreachable` in the manifest's `skipped`. Before, one such row aborted the whole build (TP-4114).
- 0e817d8: TP-1144c: add the implement-task flake screen. `screenCase` builds and tests one accepted merge in a scratch clone under `<out>/.scratch`, base once and head three times, and `screenVerdict` keeps it or names why it drops: `no-hidden-tests`, `screen-error:<msg>`, `flaky`, `fails-on-accepted`, `vacuous` or `not-collected`.
- 5b1b1c4: Read titan-design as an engineering repo and initiative, with its TD-\* task ids joined to it, so the history build includes titan-design PRs instead of dropping them as private-repo or private-marker.
- Updated dependencies [ff061ba]
- Updated dependencies [9386796]
- Updated dependencies [e8159b1]
- Updated dependencies [cca108a]
- Updated dependencies [9411e94]
- Updated dependencies [91e3e3d]
- Updated dependencies [25fcc67]
- Updated dependencies [4ea511b]
- Updated dependencies [2917ad8]
- Updated dependencies [7492819]
- Updated dependencies [211db45]
- Updated dependencies [5ba850e]
- Updated dependencies [eaa03c2]
- Updated dependencies [2256a3b]
- Updated dependencies [f896485]
- Updated dependencies [9c70c14]
- Updated dependencies [708e154]
- Updated dependencies [6a2471a]
- Updated dependencies [56d107b]
- Updated dependencies [0848c31]
- Updated dependencies [136b507]
- Updated dependencies [f5d92f3]
- Updated dependencies [974b429]
- Updated dependencies [c15f0dc]
- Updated dependencies [b3f677b]
- Updated dependencies [84d962e]
- Updated dependencies [6c2df6a]
- Updated dependencies [7a34209]
- Updated dependencies [bea67f1]
- Updated dependencies [f15a84e]
- Updated dependencies [f896485]
- Updated dependencies [c18be57]
- Updated dependencies [ed2be7e]
- Updated dependencies [e623b29]
- Updated dependencies [6f1c6b9]
- Updated dependencies [fa60411]
- Updated dependencies [f325826]
- Updated dependencies [5a67a0b]
- Updated dependencies [cfdfb64]
- Updated dependencies [ff6fb95]
- Updated dependencies [c58d555]
- Updated dependencies [c026f23]
- Updated dependencies [c525f57]
- Updated dependencies [36dc03f]
- Updated dependencies [67aa361]
- Updated dependencies [6525ba7]
- Updated dependencies [44038c9]
- Updated dependencies [7d3b5fb]
- Updated dependencies [481f3e4]
- Updated dependencies [661a027]
- Updated dependencies [801f9c4]
- Updated dependencies [207a81b]
- Updated dependencies [207a81b]
- Updated dependencies [377cca9]
- Updated dependencies [f77d79d]
- Updated dependencies [9b42150]
- Updated dependencies [37d60d1]
- Updated dependencies [cd8a1ce]
- Updated dependencies [c1f9297]
- Updated dependencies [4080191]
- Updated dependencies [5f2b39f]
- Updated dependencies [5e34e3d]
- Updated dependencies [52dc7f3]
- Updated dependencies [869014a]
- Updated dependencies [869014a]
- Updated dependencies [12afa80]
- Updated dependencies [32637bd]
- Updated dependencies [9a16e4e]
- Updated dependencies [3771a0c]
- Updated dependencies [2451aa9]
- Updated dependencies [49fa132]
- Updated dependencies [852d2a9]
- Updated dependencies [d2cce6c]
- Updated dependencies [6bc98f3]
- Updated dependencies [719f05e]
- Updated dependencies [1b0c46a]
- Updated dependencies [78ae7d9]
- Updated dependencies [4a2495f]
- Updated dependencies [0229ba6]
- Updated dependencies [ee64f09]
- Updated dependencies [7012bf0]
- Updated dependencies [2165cec]
- Updated dependencies [50fd2a5]
  - @titan-design/agent@0.7.0
  - @titan-design/authority@0.6.0
  - @titan-design/session-analytics@0.18.0
  - @titan-design/fix-proof@0.9.0
  - @titan-design/review-panel@0.9.0
  - @titan-design/evidence@0.5.0
  - @titan-design/workflow@0.14.0
  - @titan-design/session-read@0.17.0
  - @titan-design/hitl@0.10.0
  - @titan-design/review-workflow@0.1.0
  - @titan-design/store-sqlite@0.5.0
  - @titan-design/health@0.2.1

## 0.5.5

### Patch Changes

- Updated dependencies [749bea7]
  - @titan-design/fix-proof@0.8.0
  - @titan-design/review-panel@0.8.1

## 0.5.4

### Patch Changes

- Updated dependencies [e7601ef]
  - @titan-design/review-panel@0.8.0
  - @titan-design/session-analytics@0.17.3

## 0.5.3

### Patch Changes

- Updated dependencies [27f8d12]
  - @titan-design/review-panel@0.7.0
  - @titan-design/session-analytics@0.17.2

## 0.5.2

### Patch Changes

- Updated dependencies [4d131dc]
- Updated dependencies [41fce70]
  - @titan-design/fix-proof@0.7.0
  - @titan-design/evidence@0.4.0
  - @titan-design/session-read@0.16.0
  - @titan-design/review-panel@0.6.2
  - @titan-design/hitl@0.9.1
  - @titan-design/session-analytics@0.17.1

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
