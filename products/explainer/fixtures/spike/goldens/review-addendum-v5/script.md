# Review addendum: the v5 adversary feedback, and build vs buy

Two-track script, schema `script/v1`. Source of truth: `script.json` beside this file; this page is generated from it
by `tools/build_script.py`. Facts, sources and standing: `facts.md`. Sources: the two v5 adversary reviews (opus, vc),
the v5 design, the briefs, and the v6 integrator's assessment (`v5-feedback-assessment-2026-10-14.md`), all in `..`.
Plan: `../review-addendum-v5-plan.md` (revision 2). Every beat is `origin: v4`, which here means synthesized in this
build; no beat reuses audio.

**Runtime (planned):** 4:19 over 23 beats and 636 spoken words, at the provisional C5 bands
(hook 195, diagram 175, code 160, takeaways 180 wpm; `gen_audio.py` re-times each beat from the real WAV).
**Runtime (estimate):** 4:19: v2 beats at their real WAV length, v4 beats planned.

**Narration:** 0 beats reuse v2 audio; 23 are new (`origin: v4`).
**Frozen for S3:** 16: a1-1-why, a1-2-pin, a2-1-orphan, a2-1f-orphan-fix, a2-2-patchid, a2-2f-patchid-fix, a2-3f-revert-fix, a2-4f-path-fix, a3-2-dedupe, a3-3-milestones, a3-4-observed, a4-1-fact, a4-3-ingress, a4-5-built, a5-1-design, a5-2-accounts.
**CONTESTED, held:** 7. Each asserts an item the two v5 reviews dispute, or one the brief cannot vouch for;
reviewer-agent picks the line or its fallback through coordinator-a. The fallback renders by default.

| Beat | Blocker | Line | Fallback (true today) |
|---|---|---|---|
| a1-3-verdict | VC:14 vs OP:17-19, 224-235 | Eight blockers from one, six from the other. Both say not converged, not ready yet, and both call every blocker a specification fix, not an architectural one. | Eight blockers from one, six from the other. Both say not converged, not ready yet, and both call version five a real improvement. |
| a2-3-revert | opus:B5 / vc:V5-B3 | A revert moves the parent's pin, but the child checks only a digest of the parent's result, which has not changed. So its claim is still granted against a parent gone from main. | After a revert, both reviewers find the child's claim still granted against a parent gone from main. One blames the digest check; the other says the pin never moves. |
| a2-4-path | opus:B7 / vc:V5-B6 | A contract-path claim keeps a shared file to one item. It releases at park, when CI first goes green, before review, so a second item can take the file mid-fix. | A contract-path claim keeps a shared file to one item. It can release at park, which may come before review, so a second item could take the file mid-fix. |
| a3-1-merge | opus:B2 vs vc fork F-5 (VC:184) | First, from one reviewer: GitHub's merge call checks only the pull request's head, so if main moves first, an untested tree lands. The owner's call: keep the API merge, check main's tree after, and treat a mismatch as main red. | First, from one reviewer: GitHub's merge call checks only the pull request's head, so a moved main could land an untested tree. The other rates this landing shape as holding. The owner's call: keep the API merge, check main's tree after, and treat a mismatch as main red. |
| a4-2-queue | OP:385 vs BR:95 | Five edges are worth buying. First, the merge queue: GitHub's own if the repos move to an organization, else Mergify or Trunk, else our own with fast-forward. | Five edges are worth buying. First, the merge queue: GitHub's own if the repos qualify; one reviewer would try a hosted queue next; else our own. |
| a4-4-hashes | OP:456 vs VC:212-213 | Fourth, the hashes behind the pins: git gives the verbatim diff and tree hashes, and small libraries do the rest. Fifth, a lint that keeps recipes deterministic, and an eval grader. | Fourth, the hashes behind the pins: git gives the verbatim diff and tree hashes, and small libraries do the rest. Fifth, one reviewer would buy a lint that keeps recipes deterministic, the other an eval grader. |
| a5-3-next | brief (BR:66-68) | Version six is being written to answer both reviews, and another adversary round follows. Until you decide, each fix is a proposal. | Version six will be written to answer both reviews, and another adversary round follows. Until you decide, each fix is a proposal. |

**Rules applied:** the v4 explainer's layout and chrome (346); stake with numbers before 15 % (Q-W1); one pivot
into build vs buy (Q-F5); one simplification line (Q-F12). Findings are findings and fixes are proposals: a line
that uses the integrator's assessment says "the integrator proposes", because the owner has not confirmed it.
Numbers rule: narration states only 8 and 6 blockers and 520 of 999 runs merged up, plus counts of the design's own
parts and the question numbers. Where the repos live stays generic; no organization move is presumed.
`visual.recipe` follows the RecipeRunBeat contract in the plan (§5 S2a); `edge:` rows the S2b contract.

**Rules audit:** `review-addendum-v5-plan.md` not found; see the plan's §2a.

**L0 lint:** 0 errors, 0 warnings

## Video

- **Audience:** the owner: saw the redesign explainer v4, decides the v5 reviews' open calls after watching.
- **Stake:** 8 blockers from opus, 6 from vc (A03, A04).
- **Promise:** By the end, you can name what the two reviews found, what each finding would need, what to buy, and the calls that are yours.
- **Thesis:** Each step leaves a marker that stays valid until its pin moves: the code tree, the diff, or an event it depends on.
- **Generic model:** three pin kinds: tree, diff, event.
- **Fence:** the v4 explainer's design (pipeline-redesign v4), which v5 revised: v5 keys each marker by a pin per fact class instead of the head.
- **Running example:** one slice's recipe, broken and fixed once per finding in chapters 2 and 3
- **Invariants:** CI passes on the merged tree. / A verdict counts only at its exact diff.
- **Simplification:** Shows three pin kinds (tree, diff, event); v5's fourth, the item pin, is left out.
- **Close:** open-calls.

No beat draws a map. `script.json` keeps the v4 explainer's maps, unused, so the visual track keeps its shape.

## Chapters

| Id | Label | Question | Starts |
|---|---|---|---|
| ch1 | Reviews · What were they for? | What did the reviews set out to answer? | 0:00 |
| ch2 | Agreed · What did both find? | Which findings appear in both reviews? | 0:33 |
| ch3 | Single · What did only one find? | What did only one reviewer find? | 2:02 |
| ch4 | Build or buy · What do we buy? | What should be built, and what bought? | 2:54 |
| ch5 | Your calls · What is asked of you? | What do the reviews ask of you? | 3:49 |

## Reviews · What were they for?

### a1-1-why · HOOK · explain · diagram · 13 s @ 0:00

*origin:* `v4`

> Before anyone builds version five, two adversaries tried to break it, apart: one with the web, one who knew versions one to four. Is it ready, and what should we build or buy?

- **Assertion:** Two reviews before anyone builds v5
- **Job:** `map` · **Render:** `StepRailBeat`
- cue `version` → V11 rail:v5 draft, two reviews, ready yet?
- cue `buy` → V11 rail:build or buy
- chip [docs-claim] pipeline-redesign-v5-2026-10-14.md:32; adversarial-review-v5-opus-2026-10-14.md:1-7; adversarial-review-v5-vc-2026-10-14.md:1-12
- facts: A01

### a1-2-pin · GENERIC_MODEL · explain · code · 10 s @ 0:13 · in: *so*

*origin:* `v4`

> Each step leaves a marker that stays valid until its pin moves: the code tree, the diff, or an event it depends on.

- **Assertion:** A marker stays valid until its pin moves
- **Job:** `code-proof` · **Render:** `RecipeRunBeat`
- cue `step` → V11 run:ci-hold
- cue `pin` → V11 note:pin: tree, diff, event
- cue `tree` → V11 stale:ci
- chip [docs-claim] pipeline-redesign-v5-2026-10-14.md:21-23, 674
- facts: A02

### a1-3-verdict · STAKE · explain · hook · 10 s @ 0:23 · in: *but*

*origin:* `v4`

> Eight blockers from one, six from the other. Both say not converged, not ready yet, and both call every blocker a specification fix, not an architectural one.

**CONTESTED (VC:14 vs OP:17-19, 224-235):** 'None architectural' is vc's verdict only; opus calls B8's services unbuildable as written (OP:226).

> *Fallback:* Eight blockers from one, six from the other. Both say not converged, not ready yet, and both call version five a real improvement.

- **Assertion:** Both say not converged yet
- **Job:** `numbers` · **Render:** `StatBeat`
- cue `Eight` → V11 stat:8 from opus
- cue `six` → V11 stat:6 from vc
- cue `converged` → V11 chip:both: not converged
- chip [measured] adversarial-review-v5-opus-2026-10-14.md:17, 21
- chip [measured] adversarial-review-v5-vc-2026-10-14.md:14
- facts: A03, A04

## Agreed · What did both find?

### a2-1-orphan · WHAT · explain · code · 18 s @ 0:33 · in: *so*

*origin:* `v4`

> The orphan trap alarms on a valid marker the entry never reached. After a clean merge-up, the entry returns at the CI wait, short of the owner's approval, and the trap fires. Five hundred and twenty of nine hundred and ninety-nine runs merged up.

- **Assertion:** A wait returns before the trap's check
- **Job:** `code-proof` · **Render:** `RecipeRunBeat`
- cue `trap` → V11 note:orphan trap
- cue `merge-up` → V11 note:clean merge-up
- cue `returns` → V11 wait:ci
- cue `fires` → V11 orphan:verdict,owner
- cue `Five` → V11 note:520 of 999 merged up
- chip [docs-claim] adversarial-review-v5-opus-2026-10-14.md:23-27, 49-61; adversarial-review-v5-vc-2026-10-14.md:88-99
- chip [measured] adversarial-review-v5-opus-2026-10-14.md:60; adversarial-review-v5-vc-2026-10-14.md:93
- facts: A05, A06

### a2-1f-orphan-fix · HOW · explain · code · 10 s @ 0:51 · in: *so*

*origin:* `v4`

> The integrator proposes one reviewer's fix: alarm only on a marker the entry passed and skipped, never one past where it stopped to wait.

- **Assertion:** Alarm only on markers passed and skipped
- **Job:** `code-proof` · **Render:** `RecipeRunBeat`
- cue `proposes` → V11 note:call-site check
- cue `skipped` → V11 note:passed and skipped
- cue `wait` → V11 wait:ci
- chip [docs-claim] v5-feedback-assessment-2026-10-14.md:39, 50, 118-124, 169
- facts: A07

### a2-2-patchid · WHAT · explain · code · 13 s @ 1:01 · in: *and*

*origin:* `v4`

> Git's patch-id, a hash of the diff, ignores whitespace. A fixer re-indents a permissions block: CI goes stale with the tree, but the patch-id holds, so the adversary's verdict still counts.

- **Assertion:** Patch-id ignores whitespace
- **Job:** `code-proof` · **Render:** `RecipeRunBeat`
- cue `patch-id` → V11 note:pin: patch-id
- cue `re-indents` → V11 edit:perm|  permissions: write-all
- cue `stale` → V11 stale:job
- cue `holds` → V11 note:patch-id unchanged
- chip [docs-claim] adversarial-review-v5-opus-2026-10-14.md:33-34, 114-118; adversarial-review-v5-vc-2026-10-14.md:26-33; pipeline-redesign-v5-2026-10-14.md:674
- facts: A08

### a2-2f-patchid-fix · HOW · explain · code · 7 s @ 1:14 · in: *so*

*origin:* `v4`

> The integrator proposes to pin its own hash of the verbatim diff, whitespace kept.

- **Assertion:** Pin a hash of the verbatim diff
- **Job:** `code-proof` · **Render:** `RecipeRunBeat`
- cue `pin` → V11 note:pin: verbatim diff
- cue `verbatim` → V11 stale:perm,pub
- chip [docs-claim] v5-feedback-assessment-2026-10-14.md:41, 47, 65-79; adversarial-review-v5-opus-2026-10-14.md:132-134; adversarial-review-v5-vc-2026-10-14.md:43-45
- facts: A09

### a2-3-revert · WHAT · explain · code · 14 s @ 1:21 · in: *and*

*origin:* `v4`

> A revert moves the parent's pin, but the child checks only a digest of the parent's result, which has not changed. So its claim is still granted against a parent gone from main.

**CONTESTED (opus:B5 / vc:V5-B3):** vc: the pin moves and the digest compare misses it (VC:74-81); opus: an ordinary revert never moves the pin (OP:166-169). They agree only on the outcome.

> *Fallback:* After a revert, both reviewers find the child's claim still granted against a parent gone from main. One blames the digest check; the other says the pin never moves.

- **Assertion:** A revert leaves the child's claim granted
- **Job:** `code-proof` · **Render:** `RecipeRunBeat`
- cue `revert` → V11 note:parent reverted
- cue `digest` → V11 note:digest unchanged
- cue `granted` → V11 run:claim
- cue `gone` → V11 note:parent gone from main
- chip [docs-claim] adversarial-review-v5-vc-2026-10-14.md:72-81; adversarial-review-v5-opus-2026-10-14.md:162-169
- facts: A10

### a2-3f-revert-fix · HOW · explain · code · 7 s @ 1:35 · in: *so*

*origin:* `v4`

> The integrator proposes: compare pins, not digests, and spot a revert by its metadata.

- **Assertion:** Compare pins; spot reverts by metadata
- **Job:** `code-proof` · **Render:** `RecipeRunBeat`
- cue `integrator` → V11 note:integrator's proposal
- cue `compare` → V11 stale:dep
- cue `metadata` → V11 note:spotted by metadata
- chip [docs-claim] v5-feedback-assessment-2026-10-14.md:43, 49, 81-90, 112-116; adversarial-review-v5-vc-2026-10-14.md:83-86; adversarial-review-v5-opus-2026-10-14.md:171-174
- facts: A11

### a2-4-path · WHAT · explain · code · 13 s @ 1:42 · in: *and*

*origin:* `v4`

> A contract-path claim keeps a shared file to one item. It releases at park, when CI first goes green, before review, so a second item can take the file mid-fix.

**CONTESTED (opus:B7 / vc:V5-B6):** opus reads 'park' two ways and shows the release only under one (OP:197-207); vc reads it as worktree park (VC:128-133).

> *Fallback:* A contract-path claim keeps a shared file to one item. It can release at park, which may come before review, so a second item could take the file mid-fix.

- **Assertion:** The path claim releases before review
- **Job:** `code-proof` · **Render:** `RecipeRunBeat`
- cue `claim` → V11 run:ci
- cue `park` → V11 release:path
- cue `review` → V11 note:free before review
- chip [docs-claim] adversarial-review-v5-opus-2026-10-14.md:195-207; adversarial-review-v5-vc-2026-10-14.md:126-133
- facts: A12

### a2-4f-path-fix · HOW · explain · code · 7 s @ 1:55 · in: *so*

*origin:* `v4`

> The integrator proposes to release the path only when the item lands or is abandoned.

- **Assertion:** Release the path when the item lands
- **Job:** `code-proof` · **Render:** `RecipeRunBeat`
- cue `release` → V11 run:review-land
- cue `lands` → V11 release:path
- chip [docs-claim] v5-feedback-assessment-2026-10-14.md:45, 52; adversarial-review-v5-opus-2026-10-14.md:216-218; adversarial-review-v5-vc-2026-10-14.md:137-141
- facts: A13

## Single · What did only one find?

### a3-1-merge · WHAT · explain · takeaways · 15 s @ 2:02 · in: *but*

*origin:* `v4`

> First, from one reviewer: GitHub's merge call checks only the pull request's head, so if main moves first, an untested tree lands. The owner's call: keep the API merge, check main's tree after, and treat a mismatch as main red.

**CONTESTED (opus:B2 vs vc fork F-5 (VC:184)):** vc rates the landing-shape fork 'Holds' (VC:184); opus's B2 says shape (b) cannot keep I1 (OP:80-98).

> *Fallback:* First, from one reviewer: GitHub's merge call checks only the pull request's head, so a moved main could land an untested tree. The other rates this landing shape as holding. The owner's call: keep the API merge, check main's tree after, and treat a mismatch as main red.

- **Assertion:** Merging checks only the head
- **Job:** `alternatives-vs-ours` · **Render:** `CompareBeat`
- cue `merge` → V11 left:merge checks head only
- cue `untested` → V11 left:moved main lands untested
- cue `API` → V11 right:keep merge, check tree
- chip [docs-claim] adversarial-review-v5-opus-2026-10-14.md:80-106; owner's call, 2026-10-14
- facts: A14

### a3-2-dedupe · WHAT · explain · code · 13 s @ 2:17 · in: *and*

*origin:* `v4`

> Second, after a clean rebase, a check run on the old commit is deduped, leaving the new head without its required check. The integrator proposes keying commit effects by the tree.

- **Assertion:** A clean rebase drops the check run
- **Job:** `code-proof` · **Render:** `RecipeRunBeat`
- cue `rebase` → V11 note:clean rebase
- cue `deduped` → V11 note:deduped: no check
- cue `tree` → V11 stale:publish
- chip [docs-claim] adversarial-review-v5-opus-2026-10-14.md:142-160; v5-feedback-assessment-2026-10-14.md:42
- facts: A15

### a3-3-milestones · WHAT · explain · takeaways · 10 s @ 2:30 · in: *and*

*origin:* `v4`

> Third, from the other reviewer: milestone one's shadow gate compares events that only arrive at milestone two. The integrator proposes moving the event log into milestone one.

- **Assertion:** M1's gate needs M2's events
- **Job:** `alternatives-vs-ours` · **Render:** `CompareBeat`
- cue `gate` → V11 left:M1 gate needs events
- cue `two` → V11 left:events arrive at M2
- cue `log` → V11 right:event log moves to M1
- chip [docs-claim] adversarial-review-v5-vc-2026-10-14.md:106-122; v5-feedback-assessment-2026-10-14.md:51, 126-130
- facts: A16

### a3-4-observed · WHAT · explain · diagram · 14 s @ 2:40 · in: *and*

*origin:* `v4`

> Fourth, a rules change sends no event, so a newly required check is never read; under a bypass token, a candidate lands without it. The integrator proposes an event source per pin, or a time limit.

- **Assertion:** A rules change sends no event
- **Job:** `code-proof` · **Render:** `RecipeRunBeat`
- cue `event` → V11 note:rule edit: no event
- cue `check` → V11 note:new check never read
- cue `lands` → V11 run:land
- cue `source` → V11 stale:rules
- cue `limit` → V11 note:or a time limit
- chip [docs-claim] adversarial-review-v5-vc-2026-10-14.md:50-69; v5-feedback-assessment-2026-10-14.md:48
- facts: A17

## Build or buy · What do we buy?

### a4-1-fact · WHAT · explain · diagram · 14 s @ 2:54 · in: *so*

*origin:* `v4`

> Every workflow engine [memoizes](/mˈɛmoʊˌaɪzᵻz/) per run, by position or step id; none invalidates by fact and pin, and Shepherd already replays from the top. So both keep the core built: no Temporal, DBOS, Restate or [Inngest](/ˈɪnʤɛst/).

- **Assertion:** Engines memoize per run; v5 needs pins
- **Job:** `alternatives-vs-ours` · **Render:** `CompareBeat`
- cue `engine` → V11 left:memo per run
- cue `position` → V11 left:key: position or step id
- cue `none` → V11 right:key: fact and pin
- cue `Shepherd` → V11 right:Shepherd replays from top
- cue `built` → V11 left:not bought
- chip [docs-claim] adversarial-review-v5-opus-2026-10-14.md:338-378; adversarial-review-v5-vc-2026-10-14.md:195-199, 203, 218-219
- facts: A18

### a4-2-queue · WHAT · explain · diagram · 11 s @ 3:08 · in: *but*

*origin:* `v4`

> Five edges are worth buying. First, the merge queue: GitHub's own if the repos move to an organization, else Mergify or Trunk, else our own with fast-forward.

**CONTESTED (OP:385 vs BR:95):** opus verified the native queue only for org-owned public repos or GHEC (OP:385, 394-395), and so did the integrator (AS:186); Mergify and Trunk are opus's picks only.

> *Fallback:* Five edges are worth buying. First, the merge queue: GitHub's own if the repos qualify; one reviewer would try a hosted queue next; else our own.

- **Assertion:** Build the core, buy five edges
- **Job:** `artifact-filling` · **Render:** `ScorecardTable`
- cue `First` → V11 edge:merge queue|buy if eligible|GitHub, SaaS, own
- chip [docs-claim] adversarial-review-v5-opus-2026-10-14.md:385-398, 466; adversarial-review-v5-vc-2026-10-14.md:206, 224-226; v5-feedback-assessment-2026-10-14.md:186
- facts: A19

### a4-3-ingress · WHAT · explain · diagram · 8 s @ 3:19 · in: *and*

*origin:* `v4`

> Second, webhooks through a free tunnel, leaving the reconciler as a backstop. Third, Litestream to copy the one store.

- **Assertion:** Webhooks and backups are bought
- **Job:** `artifact-filling` · **Render:** `ScorecardTable`
- cue `webhooks` → V11 edge:webhooks|buy|free tunnel
- cue `Litestream` → V11 edge:store backup|buy|Litestream (beta)
- chip [docs-claim] adversarial-review-v5-opus-2026-10-14.md:249-257; adversarial-review-v5-opus-2026-10-14.md:424-430, 451-452, 470, 473; adversarial-review-v5-vc-2026-10-14.md:204, 208, 221-223
- facts: A20

### a4-4-hashes · WHAT · explain · diagram · 12 s @ 3:27 · in: *and*

*origin:* `v4`

> Fourth, the hashes behind the pins: git gives the verbatim diff and tree hashes, and small libraries do the rest. Fifth, a lint that keeps recipes deterministic, and an eval grader.

**CONTESTED (OP:456 vs VC:212-213):** The determinism lint is opus's pick only (OP:456); the eval grader is vc's only (VC:212-213).

> *Fallback:* Fourth, the hashes behind the pins: git gives the verbatim diff and tree hashes, and small libraries do the rest. Fifth, one reviewer would buy a lint that keeps recipes deterministic, the other an eval grader.

- **Assertion:** Hashes, a lint and a grader are bought
- **Job:** `artifact-filling` · **Render:** `ScorecardTable`
- cue `hashes` → V11 edge:pin hashes|buy the parts|git + libraries
- cue `lint` → V11 edge:lint, grader|buy|ESLint, evals
- chip [docs-claim] adversarial-review-v5-opus-2026-10-14.md:408-414; adversarial-review-v5-opus-2026-10-14.md:454-458, 467, 474; adversarial-review-v5-vc-2026-10-14.md:203, 207, 212-213, 219-220
- facts: A21

### a4-5-built · WHAT · explain · diagram · 10 s @ 3:39 · in: *but*

*origin:* `v4`

> Two parts stay built. Claims and pools: Kubernetes schedulers run only on Kubernetes. The event bus: a second store would split the marker's transactions.

- **Assertion:** Claims and the bus stay built
- **Job:** `artifact-filling` · **Render:** `ScorecardTable`
- cue `Claims` → V11 edge:claims, pools|build|not Kubernetes
- cue `bus` → V11 edge:event bus|build|one SQLite store
- chip [docs-claim] adversarial-review-v5-opus-2026-10-14.md:417-422; adversarial-review-v5-opus-2026-10-14.md:433-438, 469; adversarial-review-v5-vc-2026-10-14.md:205, 208
- facts: A22

## Your calls · What is asked of you?

### a5-1-design · WHAT · explain · takeaways · 12 s @ 3:49 · in: *so*

*origin:* `v4`

> Two design calls are yours. Twelve: should every version bump re-run open work, safe but costly? Thirteen: should a verdict carry to an identical diff, whitespace counted, never for a visual approval?

- **Assertion:** Two design calls are yours
- **Job:** `numbers` · **Render:** `HookBeat`
- cue `Twelve` → V11 card:Q12 re-run on every bump?
- cue `Thirteen` → V11 card:Q13 verdict on same diff?
- chip [docs-claim] pipeline-redesign-v5-2026-10-14.md:648-649; adversarial-review-v5-vc-2026-10-14.md:43-48; adversarial-review-v5-opus-2026-10-14.md:132-140
- facts: A23

### a5-2-accounts · WHAT · explain · takeaways · 9 s @ 4:01 · in: *and*

*origin:* `v4`

> Three more stay yours: where the repos live, for GitHub's queue; a webhook tunnel; and a backup target. Each touches an outside account.

- **Assertion:** Three account calls stay yours
- **Job:** `numbers` · **Render:** `HookBeat`
- cue `repos` → V11 card:repos location
- cue `tunnel` → V11 card:tunnel webhooks
- cue `backup` → V11 card:backup target
- chip [docs-claim] pipeline-redesign-v5-2026-10-14.md:39-42; v6-and-addendum-briefs-2026-10-14.md:45-47
- facts: A24

### a5-3-next · CLOSE · explain · takeaways · 9 s @ 4:10 · in: *so*

*origin:* `v4`

> Version six is being written to answer both reviews, and another adversary round follows. Until you decide, each fix is a proposal.

**CONTESTED (brief (BR:66-68)):** v6's status at render time is unverified.

> *Fallback:* Version six will be written to answer both reviews, and another adversary round follows. Until you decide, each fix is a proposal.

- **Assertion:** Fixes are proposals until you decide
- **Job:** `numbers` · **Render:** `OutroBeat`
- cue `written` → V11 title:v6, then a review round
- chip [docs-claim] v6-and-addendum-briefs-2026-10-14.md:22-28, 66-68
- facts: A25

## Facts pack

| Id | Claim | Source | Status |
|---|---|---|---|
| A01 | v5 had no adversary round when two adversaries reviewed it apart: opus with the web, vc after reviewing v1-v4; neither read the other | `pipeline-redesign-v5-2026-10-14.md:32; adversarial-review-v5-opus-2026-10-14.md:1-7; adversarial-review-v5-vc-2026-10-14.md:1-12` | docs-claim |
| A02 | The marker key is (item, fact, pin), the pin chosen per fact class (tree, diff, observed, item); CI facts take the tree pin, review facts the diff pin | `pipeline-redesign-v5-2026-10-14.md:21-23, 674` | docs-claim |
| A03 | opus: 8 blocking items, not converged; v5 is a real improvement on v4 | `adversarial-review-v5-opus-2026-10-14.md:17, 21` | measured |
| A04 | vc: not converged, 6 blocking items, each a specification fix, none architectural | `adversarial-review-v5-vc-2026-10-14.md:14` | measured |
| A05 | The orphan trap alarms on a valid marker the entry did not visit; after a clean merge-up the entry returns at the CI wait, short of the owner's approval, and the trap fires | `adversarial-review-v5-opus-2026-10-14.md:23-27, 49-61; adversarial-review-v5-vc-2026-10-14.md:88-99` | docs-claim |
| A06 | 520 of 999 runs had a merge-up (V4 §2.1) | `adversarial-review-v5-opus-2026-10-14.md:60; adversarial-review-v5-vc-2026-10-14.md:93` | measured |
| A07 | The integrator proposes vc's call-site definition: an orphan is a valid marker the entry passed and skipped, never one beyond where it stopped | `v5-feedback-assessment-2026-10-14.md:39, 50, 118-124, 169` | docs-claim |
| A08 | Git's patch-id ignores whitespace unless --verbatim; a re-indented permissions block changes the tree, not the patch-id, so a diff-pinned verdict still counts | `adversarial-review-v5-opus-2026-10-14.md:33-34, 114-118; adversarial-review-v5-vc-2026-10-14.md:26-33; pipeline-redesign-v5-2026-10-14.md:674` | docs-claim |
| A09 | The integrator proposes its own SHA-256 over a canonical verbatim diff, whitespace kept, as the diff pin | `v5-feedback-assessment-2026-10-14.md:41, 47, 65-79; adversarial-review-v5-opus-2026-10-14.md:132-134; adversarial-review-v5-vc-2026-10-14.md:43-45` | docs-claim |
| A10 | vc: a revert moves the parent's pin, not the digest of its projection, so the child's claim is still granted; opus: an ordinary revert never moves the pin | `adversarial-review-v5-vc-2026-10-14.md:72-81; adversarial-review-v5-opus-2026-10-14.md:162-169` | docs-claim |
| A11 | The integrator proposes both fixes: validity compares pins, not digests, and Reverted fires on revert metadata | `v5-feedback-assessment-2026-10-14.md:43, 49, 81-90, 112-116; adversarial-review-v5-vc-2026-10-14.md:83-86; adversarial-review-v5-opus-2026-10-14.md:171-174` | docs-claim |
| A12 | A contract-path claim keeps a shared path to one item and releases at park; under one reading of park that is the first green CI, before review | `adversarial-review-v5-opus-2026-10-14.md:195-207; adversarial-review-v5-vc-2026-10-14.md:126-133` | docs-claim |
| A13 | The integrator proposes releasing the path only at the landing result or abandonment | `v5-feedback-assessment-2026-10-14.md:45, 52; adversarial-review-v5-opus-2026-10-14.md:216-218; adversarial-review-v5-vc-2026-10-14.md:137-141` | docs-claim |
| A14 | opus B2: GitHub's merge call checks only the PR head, so a moved main can land an untested tree; the owner's call keeps the API merge, checks main's tree after, and treats a mismatch as main red | `adversarial-review-v5-opus-2026-10-14.md:80-106; owner's call, 2026-10-14` | docs-claim |
| A15 | opus B4: after a clean rebase, commit-attached effects are deduped and the new head is left bare; the integrator proposes keying commit effects by the tree pin | `adversarial-review-v5-opus-2026-10-14.md:142-160; v5-feedback-assessment-2026-10-14.md:42` | docs-claim |
| A16 | vc V5-B5: M1's gate needs events that only M2's event log produces; the integrator proposes moving the event log into M1 | `adversarial-review-v5-vc-2026-10-14.md:106-122; v5-feedback-assessment-2026-10-14.md:51, 126-130` | docs-claim |
| A17 | vc V5-B2: observed pins have no guaranteed emitter; under a bypass, a stale land-rules marker is the only check; the integrator proposes a producer per kind or a TTL pin | `adversarial-review-v5-vc-2026-10-14.md:50-69; v5-feedback-assessment-2026-10-14.md:48` | docs-claim |
| A18 | Durable-workflow engines memoize per run by position or step id; none invalidates by fact and pin; Shepherd already replays from the top; both reviews keep the core built | `adversarial-review-v5-opus-2026-10-14.md:338-378; adversarial-review-v5-vc-2026-10-14.md:195-199, 203, 218-219` | docs-claim |
| A19 | Merge queue: native where eligible (org-owned public repos or GHEC), else Mergify or Trunk (opus), else an own fast-forward queue | `adversarial-review-v5-opus-2026-10-14.md:385-398, 466; adversarial-review-v5-vc-2026-10-14.md:206, 224-226; v5-feedback-assessment-2026-10-14.md:186` | docs-claim |
| A20 | Webhooks through a free tunnel make the reconciler a backstop; Litestream (Apache-2.0, beta badge) replicates the one store | `adversarial-review-v5-opus-2026-10-14.md:249-257; adversarial-review-v5-opus-2026-10-14.md:424-430, 451-452, 470, 473; adversarial-review-v5-vc-2026-10-14.md:204, 208, 221-223` | docs-claim |
| A21 | Hashing parts are bought (git, canonical JSON, cacache); a determinism lint (opus) and an eval grader (vc) | `adversarial-review-v5-opus-2026-10-14.md:408-414; adversarial-review-v5-opus-2026-10-14.md:454-458, 467, 474; adversarial-review-v5-vc-2026-10-14.md:203, 207, 212-213, 219-220` | docs-claim |
| A22 | Claims and pools stay built (Kueue and Volcano are Kubernetes-only); the bus stays in the one store, sharing transactions with markers | `adversarial-review-v5-opus-2026-10-14.md:417-422; adversarial-review-v5-opus-2026-10-14.md:433-438, 469; adversarial-review-v5-vc-2026-10-14.md:205, 208` | docs-claim |
| A23 | Q12: every bump invalidates, fail-safe but re-running open reviews; Q13: a verdict counts at an identical diff, with whitespace and visual approvals excluded as proposals | `pipeline-redesign-v5-2026-10-14.md:648-649; adversarial-review-v5-vc-2026-10-14.md:43-48; adversarial-review-v5-opus-2026-10-14.md:132-140` | docs-claim |
| A24 | The owner keeps external accounts; the queue's home, a webhook tunnel and a backup target are new calls | `pipeline-redesign-v5-2026-10-14.md:39-42; v6-and-addendum-briefs-2026-10-14.md:45-47` | docs-claim |
| A25 | A v6 integrator answers both reviews, then a v6 adversary round follows | `v6-and-addendum-briefs-2026-10-14.md:22-28, 66-68` | docs-claim |
