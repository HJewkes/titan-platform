# @titan-design/review-panel

## 0.7.0

### Minor Changes

- 27f8d12: TP-3638: the reviewer brief says "fix-proof waived by owner" when the owner's waive-proof names the head under review. `ReviewerBriefInput.fixProofWaivedAt` replaces the fix-proof reading (and the tests member's) only when it equals the head; a waiver at any other head leaves the brief unchanged. Shepherd's review phase passes the waived head to `sh-review`.

## 0.6.2

### Patch Changes

- Updated dependencies [4d131dc]
- Updated dependencies [41fce70]
  - @titan-design/fix-proof@0.7.0
  - @titan-design/evidence@0.4.0
  - @titan-design/session-read@0.16.0

## 0.6.1

### Patch Changes

- Updated dependencies [6aa69f2]
  - @titan-design/fix-proof@0.6.0

## 0.6.0

### Minor Changes

- 7b9baf5: `reviewerBrief` takes an optional `sourceCheckout`. When it is set, the brief fetches and archives the head with `git -C "<sourceCheckout>"`, names the run dir as the reviewer's starting directory, forbids probes against the checkout, and removes only the head, base and probe dirs rather than the run dir itself. A `sourceCheckout` that is not an absolute path, or that holds a quote, `$`, backtick, backslash or control character, is refused with an error. Briefs without it render unchanged.
- f171698: Test files no longer count toward the authority, policy or security touches, and `pathTouches` exports the path-only touches with no kind-forced security.
- 9abae48: Reviewers run no tests: the default reviewer test rule, now exported as `CI_REVIEWER_TEST_RULE`, has them cite the CI check-runs (name and conclusion) at the reviewed head and treat a missing, running or red required check as blocking. Shepherd uses it on every host, and its fixer rules name `pnpm test:affected` (TP-1727 slice 3). The review-pr eval's offline trial brief swaps in its own no-CI test rule.
- cf7c870: Add `reviewPullRequest(request, ports, opts?)`, the one entry point over the panel's ports: it classifies, plans, spawns members in parallel under `memberName`, corrects a malformed reply once, retries a silent member once under a fresh name, and returns `aggregate`'s verdict. A repeat call with the same input reuses the roster rows. Also exports `memberName`, `SPAWN_REFUSED_REASON` and the `ReviewRequest`, `ReviewPorts`, `ReviewClock` and `ReviewOptions` types.
- b0a3f7b: `shepherd.review.panel: on` now reviews a head with its planned panel. The correctness member keeps `sh-review:<head>` and `sh-await-verdict:<head>`; every other member runs `sh-review:<head>:<shape>` and `sh-await-verdict:<head>:<shape>` at its planned profile with its shape's brief, and `sh-review-panel:<head>` records the aggregate. A panel MERGE carries `panel: {satisfiesG10, degraded, members}`, and a panel FIX_FIRST carries each member's findings and the panel's defect class. A run whose intent recorded no plan continues as a single reviewer. `ReviewerFacts` gains `profile`, which a reviewer dispatch spawns at in place of the class's profile.
- ed7042a: The reviewer brief takes `ownerPicks` and lists each grammar-valid pick as declared, asking the reviewer to add `Owner pick contradicted: <id>` instead of blocking on it. `contradictedPicks` reads those lines back for the recorded ids.
- ca49f58: `reviewerBrief` asks every FIX_FIRST, a first review included, for a `Defect class:` section. A new `earlierFindings` input hands a re-review the run's earlier FIX_FIRST findings with their classes, fenced between `EARLIER-FINDINGS` markers with every verdict-block line removed; the brief then asks for an `Earlier findings:` checklist of `- fixed:` / `- not fixed:` lines (or `Earlier findings: none found`) and for a recurring class's line to be copied exactly. Exports `EarlierFinding`, `EARLIER_FINDINGS_START`, `EARLIER_FINDINGS_END` and `EARLIER_FINDINGS_HEADING`.
- 2ea3f8a: Add `securitySliceFlag` and `SECURITY_SLICE_LINES` (400) to flag oversize security or guard-area slices (TP-2395 a). The `generated` set now also leaves out changesets, `packages/*/api/*.d.ts` reports and `.codewatch/dead-exports.json`, so `changedLineCount` and the `large` touch no longer count that churn; a PR sized only by it may now class `standard`. `pnpm-lock.yaml` and snapshots stay counted, since a hand edit there changes what runs.

  Add a `dependency` touch, STRICT like `security`, so a PR that changes `pnpm-lock.yaml`, `pnpm-workspace.yaml` or any `package.json` classes `g10` at any size. `touchesDependency(files, rules?)` is exported, and `ReviewerFacts.dependencyTouch` lets a caller that sizes reviewers itself apply the same rule. `ClassRules.dependency` is a new required field (a minor bump under 0.x): a caller that builds its own `ClassRules` must add it.

- adfec4b: `reviewerBrief` and `correctionPrompt` ask every MERGE for the `CI-policy:` line (`CI_POLICY_RULE`), and `acceptVerdict` carries it on a MERGE as `ciPolicy`.
- 4ba57bf: TP-2422: Shepherd's G10 registration hold now covers a branch registration when `sh-await-pr` finds its PR, and a repeat registration whose diff grew past 400 lines or into a stronger class. A weaker G10 hold, placed during the file read or inherited, no longer blocks escalation to `g10-adversary`. `release-head.ts` and Shepherd's `commands.ts`, `operator-hold.ts`, `seats.ts`, `release.ts` and `reviewer-choice.ts` count as policy paths, and a rename is classed by its old path as well as its new one. A hold history that cannot be read holds `g10-adversary`. `ReviewerFacts` gains `g10Hold`, so a run that holds or held a G10 hold gets the g10 reviewer.
- 7dbe2bb: An `error` fix-proof verdict is blocking: the tests brief says so and `aggregate` makes the tests member block on it. `reviewerBrief` takes `fixProofUnverified` (`error`, `untrusted` or `unread`) and adds a closed-map section telling the reviewer the proof is blocking unless an added test is shown failing on the base (TP-2434 a).
- ba8f25e: Reviewers may propose non-blocking follow-up tasks in a `Follow-ups:` section (`- <title> | <done_when> | low|medium|high`, at most five). `parseFollowUps` reads it and drops a malformed block whole with a named warning; `acceptVerdict` carries `followUps` and `followUpsWarning` on MERGE and FIX_FIRST without changing the verdict, and `reviewerBrief` teaches the section through `FOLLOW_UPS_RULE` (TP-2498 b).
- 4dc300d: `acceptVerdict` refuses a MERGE whose CI-policy line reads malformed with the new `ci_policy_malformed` refusal, so the reviewer gets one correction turn instead of the merge guard gating the PR. The brief and correction prompt state that the line holds nothing else, and `MAX_CORRECTION_PROMPT_CHARS` rises from 1500 to 1600 to fit that sentence. A binary older than this release reads a stored `ci_policy_malformed` record as no record and sends the PR to a fresh reviewer.
- 5f5dce9: review-panel: the adversary brief asks for a `Probes:` line above the verdict, and `acceptVerdict` refuses an adversary verdict without one as `probes_missing` (one correction, whose prompt restates the form; the correction cap rises to 1700 characters). `AwaitVerdictInput.shape` names the member awaited. `ShapeBriefInput.holdContext` puts a hold's reason, matched files, done-when and last report into the adversary brief, fenced as data. `ShapeRule.always` plans a shape whatever the files touch.

  factory: with `shepherd.gateReset.twoMergeRelease` set to `shadow` or `on`, a run held `g10-adversary:` gets Shepherd's own adversary member beside correctness, whatever `review.panel` says, at `review.adversaryProfile` (default `fable-reviewer`) and under `review.adversaryConfigDir` when set. Its brief carries the hold reason, and a verdict with no `Probes:` line gets one correction turn. Nothing releases on it yet. Absent or `off` changes nothing.

- 6b222d0: Reviewers no longer read CI with `gh api`, which reviewer sessions deny (TP-3050). `ReviewerBriefInput.ciChecks` carries the check-runs serve read at the reviewed head (name, status, conclusion, required) and replaces the test rule with a filtered table the reviewer judges CI from. Without it, `CI_REVIEWER_TEST_RULE` falls back to `gh pr view --json headRefOid,statusCheckRollup` and has the reviewer list `CI_UNREAD_LINE` when it cannot read CI at the head; `ciUnreadOnly` tells a FIX_FIRST whose only item is that line. `greenChecks`, which no caller set, is removed.

  Shepherd's reviewers get the new fallback rule through `suiteRules`.

### Patch Changes

- cd013d1: The reviewer brief no longer shows a CI table that leaves out a required check. When a required check-run has a name the table cannot carry (such as `build (22)`) or would fall past the row cap, the brief tells the reviewer to read CI itself instead of presenting a partial table as complete. Required rows now sort ahead of non-required ones before the cap applies.
- 089ac2c: Class a PR as visual under `apps/` only for files that can change rendered output (components, styles, html, svg, images, `src` and `public` trees), so a server-only console PR no longer opens a visual gate.
- 30c7ab5: `reviewerBrief` confines a reviewer's probes to a scratch repo under its run dir whose origin is a local bare repo, never the real checkout it starts in or a real remote.
- eae2dc4: `aggregate` makes the tests seat blocking on an `unproven` fix-proof, and a bare unpinned `reproduced` word no longer satisfies G10 (TP-2356 a).
- 2503c0c: The tests and reviewer briefs trim a fix-proof/v1 line before parsing it, as aggregate does, so a padded line reads the same in the brief and in the verdict.
- 29e51f1: `securitySliceFlag` also matches a rename's `previousPath`, so a slice that moves guard code out of the guard area is flagged (TP-2575 a).
- ac8bf42: Shepherd no longer withholds the merge-on-green grant for an unverified fix-proof (owner decision 303, reversing TP-2434). A fix-proof read that errors is read once more at the same head first. The unverified standing and its read reason are recorded on the merge evidence (`proofUnverified`) and in the evidence PR comment, and an unverified proof no longer asks the reviewer for an owner brief. The reviewer's unverified-proof brief no longer says a MERGE goes to the owner.
- 7a47bb3: pathTouches and classifyPr also match a rename's previousPath, so renaming a guard file away keeps its security touch.
- Updated dependencies [59131da]
- Updated dependencies [62adbb2]
- Updated dependencies [adfec4b]
- Updated dependencies [c2d805b]
- Updated dependencies [336aaf2]
- Updated dependencies [7499737]
- Updated dependencies [069c3b2]
- Updated dependencies [ba8f25e]
- Updated dependencies [15b5395]
- Updated dependencies [462e693]
- Updated dependencies [7d93a92]
- Updated dependencies [edcb589]
- Updated dependencies [5cd4f1b]
- Updated dependencies [abadd64]
- Updated dependencies [b6072b5]
  - @titan-design/fix-proof@0.5.0
  - @titan-design/session-read@0.15.0
  - @titan-design/evidence@0.3.0

## 0.5.4

### Patch Changes

- 5985f32: The reviewer brief now names the final message as the verdict channel and says the reviewer needs no chat_send; it no longer says "send your verdict".

## 0.5.3

### Patch Changes

- b60d484: `aggregate` fails closed on fix-proof input it cannot read. A `fix-proof/v1` line is parsed with fix-proof's `parseResultLine`, and it makes the tests member blocking when its verdict is `vacuous` or `no-tests`, when it names another head, or when it does not parse. Any other unrecognised non-empty `fixProof` also makes the tests member blocking.
- Updated dependencies [7b9335c]
  - @titan-design/session-read@0.14.0

## 0.5.2

### Patch Changes

- Updated dependencies [8bc0f25]
- Updated dependencies [ef240c0]
  - @titan-design/fix-proof@0.4.0

## 0.5.1

### Patch Changes

- Updated dependencies [7c73654]
  - @titan-design/session-read@0.13.0

## 0.5.0

### Minor Changes

- 3d3cc58: Add the optional `ReviewerMessage.synthetic` field: set only for a record the client wrote in the model's place, with the API error it names and the quota reset, read from the record's own fields and never from its text.

  `acceptVerdict` now reads a usage-limit notice as a limit only when the client wrote it (a `synthetic` record naming no API error, `rate_limit` or `usage_limit_reached`); the same words written by the reviewer are a malformed verdict. A limit result keeps the notice text and, when recorded, `resetsAt`. The new `isUsageLimit` export tells a limit result apart from any other `none`.

### Patch Changes

- Updated dependencies [3d3cc58]
  - @titan-design/session-read@0.12.2

## 0.4.0

### Minor Changes

- 1add3c6: The reviewer brief can name the checks already green at the head and the fix-proof line, and asks the reviewer not to rerun them.

## 0.3.0

### Minor Changes

- d7102a6: Add brief overlays for the adversary, tests, visual and perf panel shapes. Each has a stable id and a sha256 content hash, and `shapeBrief` puts it on top of the base reviewer brief. The tests brief reads a `fix-proof/v1` result line for the head when one is given.
- 73683d7: `ReviewerFacts` gains an optional `intentAt`, the epoch-ms the run's review intent was recorded, so a spawn gate can admit deferred reviews oldest-first.
- 7d52415: Add `aggregate(plan, results, input)`, the fail-closed panel verdict for one head. Any blocking FIX_FIRST blocks, MERGE needs every blocking member's MERGE at the head, and a missing blocking member is `no-verdict` or `timeout`, never MERGE. Advisory findings ride along only when their `path:line` citations exist at the head (checked with `@titan-design/evidence`), findings are bounded per member, and `satisfiesG10` is false when any member is degraded. Exports the `MemberResult` and `AggregateInput` types.
- 446c60a: Move Shepherd review checkouts to the titan-factory app data dir. `reviewerBrief` now requires `checkoutRoot`, puts the head and base checkouts under `<checkoutRoot>/<run>`, and tells the reviewer to remove that whole dir. Shepherd also removes the run dir when the verdict step ends, and the stale-checkout sweep reads the same root.

### Patch Changes

- Updated dependencies [3bf2ac3]
  - @titan-design/session-read@0.12.0

## 0.2.0

### Minor Changes

- 619dc1e: Add Shepherd's verdict acceptor: `acceptVerdict`, the FIX_FIRST findings helpers (`fixFirstFindings`, `boundedFindings`), `parseOwnerBrief` and `OwnerBriefSchema`, the Malformed refusals (`MALFORMED_REFUSALS`, `MalformedSchema`, `readMalformed`), `namesTarget`, `namesPr` and the review depth floor (`DEPTH_FLOOR_REASON`, `isInvestigativeCall`). `zod` is now a peer dependency.
- dc635a8: `reviewerBrief` takes an optional `testRule`, the line telling the reviewer where to run tests; absent, it keeps the `ssh basement basement-suite` form.

### Patch Changes

- @titan-design/session-read@0.11.1

## 0.1.0

### Minor Changes

- d3e5f57: Add `classifyPr(facts, rules?)` and `DEFAULT_CLASS_RULES`: a pure classification of a pull request into `g10` or `standard` with its touch flags, from paths, kind, size and the caller's authority and policy hints.
- a18ef2a: Add `planPanel(cls, policy, headroom)`: a pure plan of a PR's review panel with each member's shape, profile, brief id and blocking flag, a spend estimate in points, at most 3 members and 1 opus member, and opus planned at its sonnet profile with `degraded: true` when headroom refuses it. `DEFAULT_PANEL_POLICY` has no panel table and plans the correctness member alone at the `g10` and `standard` profiles; `DEFAULT_PANEL_TABLE` is the opt-in class table.
- 37ef1c9: Add the Shepherd reviewer briefs: `reviewerBrief`, `correctionPrompt`, the owner-brief lines and `REFUSAL_SENTENCES`, with the constants they share.
- d4722b2: `ReviewerAgent` gains an optional `profile`, the profile the agent was spawned with, for a dispatch port whose roster reports it.
- 0a58927: Add `@titan-design/review-panel` with the review panel's types (`PrFacts`, `PrClass`, `PanelPlan`, `PanelVerdict`, `ReviewTarget`) and the reviewer ports a caller satisfies (`ReviewerDispatch`, `ReviewerReader`, `ReviewerAgent`, `ReviewerMessage`). Types only; no runtime behaviour yet.

### Patch Changes

- cf3b0d0: Build the reviewer brief's checkout-removal path from `reviewCheckoutName`, and give Shepherd one home each for its home-path prefixes and its run policy ceiling. No behaviour change.
- d4db9bc: Add `changedLineCount` and a `generated` glob list to `ClassRules`: generated registry files (CAPABILITIES.md, site reference pages, the reference sidebar, the capabilities guide, `.codewatch/check.json`) no longer count toward a large PR, unless they alone pass `largeLines` or a rename moved the file in from a written path. `ChangedFile` gains `previousPath` and `ReviewerFacts` gains `sizeUnread`.
- Updated dependencies [f34ae27]
- Updated dependencies [495e6f8]
- Updated dependencies [74f9f51]
- Updated dependencies [a8faac4]
- Updated dependencies [1aed39d]
- Updated dependencies [1fd9652]
- Updated dependencies [deb35d0]
- Updated dependencies [295acf8]
- Updated dependencies [59ba612]
- Updated dependencies [ff6ff86]
- Updated dependencies [c466784]
  - @titan-design/session-read@0.11.0
