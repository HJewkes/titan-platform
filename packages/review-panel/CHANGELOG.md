# @titan-design/review-panel

## 0.9.0

### Minor Changes

- c18be57: Scope a fix-round re-review brief to the fix diff (TP-3735): `ReviewerBriefInput.scope` (`ReviewScope`: `sinceHead`, `paths`, `hunks`, `mergedBase`), given with earlier findings, swaps `gh pr diff` for `git diff <sinceHead> <head> -- <paths>`, lists the fix's line ranges, makes the `Earlier findings:` checklist required with a `- partly fixed:` option, and adds the unchanged-line rule (`Important:` plus `Class:`), the no-repeat rule and the callers rule. A scope that fails `usableScope` (shell-active path, short sha, over `MAX_SCOPE_PATHS`, no open finding) leaves the brief full; with no scope every brief is byte-identical. `shapeBrief` drops `scope`, so panel members keep the full diff. Exports `IMPORTANT_TAG` and `CLASS_TAG`.
- 44038c9: Shepherd no longer asks the owner to merge a fix-first-runaway or no-progress head (D8, `GATE_DEMOTIONS.fixFirstRunaway`, on by default). One fresh reviewer gets the run's FIX_FIRST trail as a convergence review: its MERGE takes the normal land path, and its FIX_FIRST sends the repo's seat (or the hub seat) a `fix-first-planner` notice while the run waits for a new head. A moved head re-arms the review. The reviewer brief gains `convergence`, which asks for a `Convergence:` section tagging each open finding Important, Nit or Pre-existing.
- 7d3b5fb: Add the `scope_untagged` and `repeated_finding` refusals (TP-3735 S5) and export their `ScopeRefusal` type. Their correction prompt tells a scoped fix-round FIX_FIRST which rule it broke (an out-of-range item with no `Important:` and `Class:` line, or a restated earlier finding) and that its reply stands as written, within `MAX_CORRECTION_PROMPT_CHARS`.
- 481f3e4: The panel aggregate counts a vacuous fix-proof that `provedByMutants` proves as good, as Shepherd's fix-proof judge already did, so it no longer adds an unplanned blocking tests seat that left every round `no-verdict`. `PanelVerdict` gains `fixProofShortfall`, set when that unplanned tests seat is the only blocking member missing; when that proof is vacuous or test-less, Shepherd sends the head back as its own NO_REPRO instead of retrying a fresh reviewer, and an owner's waiver of it now clears the seat on a test-only head that proceeds.
- 377cca9: `ReviewerDispatch.spawn` and `resume` take an optional `AbortSignal` as their last argument. A dispatch that waits before starting the reviewer stops waiting, and starts nothing, once the signal aborts.
- 52dc7f3: A reviewer verdict correction now quotes the line that made the verdict malformed (TP-3798). `session-read` exports `refusedLines(text, refusal)`, which returns the non-canonical `Verdict:` lines (for `multiple_blocks`) or labelled CI-policy lines (for `ci_policy_malformed`); the reading itself is unchanged and still fails closed. `review-panel` records them as `malformed.quotes`, and `correctionPrompt` takes `quotes`, shows up to three of them cut to 120 characters inside `MAX_CORRECTION_PROMPT_CHARS`, and asks the reviewer to reword or remove them. `CI_POLICY_RULE` now says no other line may start with "CI policy" or "Verdict", markdown headings such as `**CI policy:**` included.
- 12afa80: `planPanel` caps premium seats by price class: `fable-reviewer` joins `bd-reviewer` in `DEFAULT_SONNET_FOR`, so a Fable member takes the one premium seat and is priced at premium points. A `ShapeRule` with `uncapped: true` keeps its premium profile beside the capped seat (headroom still lowers it). `PanelPolicy.installed` lets the caller say which profiles exist; a premium member lowered to one that does not throws `UninstalledProfileError` at plan time. Because `aggregate` reads the same default table, a g10 correctness member at `fable-reviewer` now counts as premium for `satisfiesG10`.
- 852d2a9: `fixProofNeedsTests` is exported: the predicate `aggregate` uses to make the tests seat blocking. Shepherd's review intent plans a blocking tests member whenever it holds, so an `unproven` or `error` fix-proof on a panel with no tests member is reviewed by one instead of ending every round as no-verdict (TP-4195). A panel that still meets the unplanned seat (an intent recorded before this change) says so in its no-verdict reason, and the diagnosis brief no longer claims no reviewer was dispatched when every one answered.
- 6bc98f3: `acceptVerdict` takes a MERGE's exact `CI-policy: unchanged` line at Head+1 when every other CI-policy-labelled line is prose (bold, a list item or a sentence) that only says nothing changed (an allowlist: `unchanged`, or no files under `.github/` changed), instead of refusing the block as `ci_policy_malformed`. A weakened reading still wins. A refusal where every other labelled line is prose is recorded as the new `ci_policy_prose` refusal, apart from `ci_policy_malformed` (TP-4391).
- 7012bf0: Shepherd's fix-proof gate takes CI as the proof for a PR whose diff is only `.github/workflows/**` (changesets and the repo's declared generated files may ride along), since no unit test can cover a workflow edit (TP-3861). `sh-fix-proof` then reads the base branch's required checks from check-runs instead of the fix-proof run: it records a `workflow-ci` read citing each required check's newest run at the merge base and at the head. The read passes when a required check concluded failure at the merge base and every required check concluded success at the head; otherwise the review ends as NO_REPRO carrying the read. A passed read reaches the reviewer as `workflowCiProof`, a new `ReviewerBriefInput` field, and the brief names CI as the proof and tells the reviewer not to ask for a unit test; the tests panel member reads it in place of the missing-result line. A mixed diff keeps the fix-proof run path unchanged.

### Patch Changes

- 7492819: - **Count work in timing tests instead of reading a clock (TP-4262).** Glob growth tests compared thread CPU ratios, which read up to 415 on a loaded hosted runner and turned main red. fix-proof's `LinearRegExp` now counts its NFA steps (`linearRegExpSteps`), and test-kit's `linearWork` compares those counts across a size ladder. It replaces the timed `linearGrowth`, which is removed. A matcher that falls back to a backtracking RegExp counts nothing and fails at size 1. test-kit also adds `countCalls` and `callMeter`, which count calls to chosen methods and stop at a cap. fix-proof's brace and glob rows and code-graph's reach and link rows use them in place of millisecond limits.
  - **Refuse new clock limits in tests.** eslint-plugin adds `no-test-clock-budget`. It reports a test that compares a clock reading, or a ratio of readings, with a limit outside a bench gate. The repo enables it with a shrink-only baseline that TP-4264 empties.
- c15f0dc: Add `shepherd.gateReset.noReproProceed` (off by default): a test-only PR whose diff the classifier reads as tests alone goes to review on a vacuous or test-less fix-proof, recorded as unverified `no-repro-test-only`; the reviewer brief names it.
- 7a34209: The remaining RegExp glob compilers match in time linear in the path (TP-4223). fix-proof exports `LinearRegExp`, also from `@titan-design/fix-proof/linear-regexp`: a RegExp whose `test` simulates its source as an NFA, so a glob such as `d/` and twenty `*`, or `**/` repeated twelve times, can no longer hang a match. review-panel's `matchesGlob`, autoresearch's bounds globs, code-graph's `patternToRegex` and `.gitattributes` patterns, and tool-guard's merge-lint `globToRegExp`, guarded path patterns and glob command words now build one. Each still returns a RegExp and matches what it did, except that a glob too large for V8 to compile, which used to throw at its first test, now matches as written. test-kit exports `linearGrowth`, a growth-ratio ladder that fails a polynomial matcher on a small input before trying a large one, and `hostileGlobs`, the timing rows of tp#2491.
- f15a84e: Add `shepherd.gateReset.nonSourceNoRepro` (`keep-owner` when absent, today's behaviour). With `record-fact`, a fix-proof NO_REPRO on a non-security PR that changes no source goes to review marked unverified `no-repro-non-source`, and no `sh-sent-back` owner gate opens; the merge grant is unchanged. No source means the fix-proof plan, under the trusted configs, sorts no path as source, or the diff is the workflow-only diff a CI proof read. `@titan-design/review-panel` exports `noReproProceedOf`, the one reading of which unverified standings proceed and on what, so the brief rule, the tests member question and the panel plan all follow it. The row is live-editable (TP-4275).
- ed2be7e: Clear the typed-lint baseline for the package: narrow the tool-call input and index reads instead of casting, and drop optional chains the types already rule out. No change for well-formed input.
- 801f9c4: A test-only head that proceeds on its vacuous fix-proof no longer dead-ends under the review panel (TP-4058). Shepherd plans a fresh, blocking tests member for it, right after a g10-adversary hold's member, instead of leaving aggregate's unplanned tests seat empty and sending the head back as the proof's NO_REPRO. The tests member's brief asks, for each changed test, whether it would fail without the change it covers. Its MERGE lets the panel merge with no waiver; its silence is still no verdict, and its FIX_FIRST goes to the fixer. A diff that also changes source still ends as NO_REPRO, and an intent recorded before this change keeps the old NO_REPRO.
- 32637bd: `proofStanding(read, head)` in fix-proof is the one reading of a fix-proof read at a head: `proved`, `no-repro` (with `proceeds` for a test-only or non-source NO_REPRO the caller lets through), `unverified`, `unproven` or `none`. `endsReview` and `needsTestsSeat` answer the two questions callers ask of it, and `FixProofUnverified` moves here. Shepherd's gate and waiver and review-panel's `fixProofNeedsTests` now derive from it instead of parsing the line each in their own way; no behavior changes, and `unproven` still lets the review run while making the tests seat blocking. review-panel re-exports `FixProofUnverified` unchanged. review-workflow's `ProofRead` is now fix-proof's `ProofReadInput` (TP-3923).
- d2cce6c: Give the fix-proof result line a `refused` verdict for a PR whose base is not the default branch (TP-4259). A refused line names the PR's `base` and the `defaultBranch` in fields of their own, with no count and no test, so no reader parses a message to find a refusal. Every judged line may also carry the `base` it judged; `fix-proof judge` takes it as `--base-ref`, and `fix-proof-run.sh` passes it from the workflow's `BASE_REF`. A reader that predates either field rejects the line, so it fails closed.

  The review panel counts a refused line as a bad fix-proof, as it did the error line that carried the refusal before.

  Shepherd's fix-proof read binds a run to the PR only when GitHub lists it on the PR's base and its line, if it names a base, names that same base. A run GitHub lists on main after a retarget, whose line judged the stacked parent, no longer counts as a second run on main. A job log that cannot be read is read again on the next poll and is an error at the deadline. A run's distrust is settled before its verdict is read. A refused line's standing is `refused`, and the MERGE evidence records the base the line judged as `proofBase`.

- Updated dependencies [7492819]
- Updated dependencies [eaa03c2]
- Updated dependencies [f896485]
- Updated dependencies [9c70c14]
- Updated dependencies [708e154]
- Updated dependencies [6a2471a]
- Updated dependencies [56d107b]
- Updated dependencies [0848c31]
- Updated dependencies [136b507]
- Updated dependencies [f5d92f3]
- Updated dependencies [7a34209]
- Updated dependencies [bea67f1]
- Updated dependencies [5a67a0b]
- Updated dependencies [cfdfb64]
- Updated dependencies [ff6fb95]
- Updated dependencies [36dc03f]
- Updated dependencies [67aa361]
- Updated dependencies [6525ba7]
- Updated dependencies [661a027]
- Updated dependencies [f77d79d]
- Updated dependencies [9b42150]
- Updated dependencies [cd8a1ce]
- Updated dependencies [4080191]
- Updated dependencies [5f2b39f]
- Updated dependencies [52dc7f3]
- Updated dependencies [32637bd]
- Updated dependencies [2451aa9]
- Updated dependencies [d2cce6c]
- Updated dependencies [719f05e]
- Updated dependencies [78ae7d9]
  - @titan-design/fix-proof@0.9.0
  - @titan-design/evidence@0.5.0
  - @titan-design/session-read@0.17.0

## 0.8.1

### Patch Changes

- 749bea7: A pull request that only adds or changes tests can now prove itself without an owner waiver (TP-3658). `@titan-design/fix-proof` exports `provedByMutants(result)`: true when a `vacuous` result's mutation check is `killed`, every changed test file has a spec of its own in the diff, no test was deleted or renamed out of the tests, and every selected test ran and passed at head. The judge attaches mutants only to a diff `testOnlyReading` calls test-only, so one that deletes a test never carries them. The judge lists changed test files without a spec as `mutants.uncovered` and demotes `killed` to `not-killed` when any remain, so a spec beside an unchanged test cannot vouch for a test the PR changed. The fix-proof workflow gains a `fix-proof-mutants` job that runs `exec --side mutants` in the sandbox when the diff adds or changes a `*.mutations.json` spec, and the judge reads its report. Shepherd's fix-proof gate lets such a head go to review; a surviving mutation, a failing or unrun test, or a mutants error still ends the round as `NO_REPRO`, and the wake asks for kills. The tests reviewer's brief reads a proved head as proved rather than as a blocking vacuous proof. A run may now move into `--kind test-only`, under the existing diff check.
- Updated dependencies [749bea7]
  - @titan-design/fix-proof@0.8.0

## 0.8.0

### Minor Changes

- e7601ef: TP-3642: the panel aggregate honours the owner's fix-proof waiver. `AggregateInput.fixProofWaivedAt` keeps a vacuous, missing or failed fix-proof from making the tests member blocking, or from counting an unplanned tests member as missing, only when it equals the head; a waiver at any other head changes nothing. `reviewPullRequest` and Shepherd's sh-review-panel step pass it through.

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
