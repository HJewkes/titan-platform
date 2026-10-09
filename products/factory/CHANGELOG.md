# @titan-design/factory

## 0.10.0

### Minor Changes

- f5ce3d5: `shepherd hold` refuses a reason whose class (the text before the first `:`) is not one of `serve-down`, `stalled`, `no-reviewer`, `run-failed`, `visual-gate2`, `g10-review` or `g10-adversary`, and refuses the four factory-defect classes when the reason cites no task ID. A refusal exits 65 and changes nothing; releasing or replacing an existing untyped hold still works. Shepherd CLI verbs now exit with the error envelope's sysexits code instead of 1.

## 0.9.0

### Minor Changes

- dbcd77b: The digest config gains `copyDirs`, a list of directories each digest is copied to; a failed copy warns naming the directory and never fails the run. `icloudDir` still parses as a legacy alias and joins the list.
- cff7a11: `titan-factory gate resolve` from an agent-chat shell resolves as the coordinator, with no presence dialog, for three gate classes the owner let through on 2026-10-07 (TP-1904): an approve-merge at a head a reviewer said MERGE at, under an `authority/MRG-AU` decision whose recorded reason names only mechanical unmet conditions (reviewer verdict, required checks, merge tree) and an `auto` seat, with the base's required checks green at that head and the PR mergeable; a main-red acknowledgement or main-frozen unfreeze once the base's green tip contains the merge; and an abandon of a PR gate whose PR is merged or closed. The command reads the evidence fresh through the GitHub port, the gate store re-checks it with `coordinatorEvidencePolicy` and stores it on the gate as `resolvedEvidence`. Any failed or partial read falls back to the presence dialog. The factory database gains `gateEvidenceMigration` as version 14.
- 54a7a3a: Device gates (`device-*` step ids, such as `device-confirm`) answer only to the owner at the factory's terminal: the store's `authorize` refuses every class the authority table's HW-CO row does not name, and any channel but `factory-cli`, so a remote owner, a signed resolve-proof, a coordinator, the decider, an agent and automation all leave the gate pending with a named reason. Other factory gates are unchanged and still admit no rule delegate.
- 5b88296: Release a `g10-review` hold without a seat command when the run's own opus reviewer (`shepherd.review.profile`) has sent MERGE at the PR's current head, read fresh, and the required checks are green there. The `sh-g10-release` step records the verdict ref. `g10-adversary` and every other hold class still need `shepherd release`.
- 83e9df6: Add `applyProof`, the server-side core for owner-signed gate answers. It verifies a signed statement with `verifyProof` and refuses a nonce it has already seen. It then checks each item against its live gate. A batch may hold only plain merge gates answered `merge` at the listed head; release and hardware gates stay one per proof. The proof (statement, signature, key id, nonce, audience, window) is recorded before any item fires. Each item fires only while its gate is still pending at its exact head, as `owner-terminal` `key:<keyId>` on channel `factory-proof`. An item that moved or closed is skipped and named. New tables `gate_batch` and `gate_batch_item` (migration 15).
- 1753ee0: `LandOptions.askApproval` asks a head-bound question in place of the `approve-merge` gate. `merge` approves only the head it was asked about, `abandon` stops the land, and `{ failed }` returns a `ci-failed` outcome with one `device-check` failing check whose `workflowRunId` is null, so it is never auto-rerun. Without the hook, land opens `approve-merge` as before.
- a4ec3a3: Add `titan-factory needs [--json]`, one merged owner list over the agent-chat queue, factory gates, Morning queues and needs-decision tasks, with duplicates folded and named and personal initiatives left out. The digest's "Needs you" section now reads this list.
- 2fb8e43: `titan-factory serve` registers `needs.list` and `needs.count`, so the console reads the owner's merged queue over loopback (`POST /rpc/needs.list`) or MCP (`needs__list`). `needs.list` returns `{ items, gaps }`, where `items` is the OwnerItem[] `titan-factory needs --json` prints, filtered by `kind`, `lens` and `initiative`; personal initiatives are left out unless `personal: true`. `needs.count` returns `total`, `byKind` and `byLens` under the same filters. An agent-chat `approval_request` or `endorse_request` row now stays a one-way approve item even when its meta names another item kind.
- 051af4c: Report owner friction. `shepherd stats` now also prints, per UTC day, the gates an owner class resolved and, per gate kind, the median and maximum hours gates waited on the owner, with open gates counted to now; a gate any other actor resolved is not counted. The morning digest shows both as an "Owner friction" section. `shepherd stats --json` now returns `{ merges, ownerFriction }` instead of the bare merge rows.
- 7255570: Add an optional `remoteFactory` URL to the factory config. While it is set, `serve`, `resume`, `land`, `gate resolve` and `shepherd register|hold|release|resync` exit 2 before probing a serve or opening any database, and every other verb refuses to open the local database; the message names the remote and says this host's database is frozen. A misspelt `remoteFactory` key fails the config load.
- 2a8b32a: Add `POST /gates/resolve-proof` on `serve`. It applies an owner-signed proof through `applyProof` and returns each item's outcome. The route is mounted through the daemon's `mountRoutes`, behind its existing guards, and is neither an MCP tool nor an RPC command; bodies over 512 KiB get 413. Owner public keys load once at start from the fixed root-owned directory `/etc/titan-factory/owner-keys/*.pem`, with every path component lstat-checked (uid 0, no group or other write, no symlink); a failed check or no key answers 503 `owner keys not installed`. `/health` reports `ownerKeys` (the loaded key ids, or the refusal), and `factory.gates` returns `aud`, the hostname a proof must name.
- 92b14ab: Shepherd routes seat work to the registering seat instead of the owner. A `ci-failed` red no fixer took, an `sh-sent-back` send-back no agent took or a spent repair budget, and a `stuck-behind` update budget now record an `sh-seat-notice` step that messages the repo's seat. The run then takes the default action: it waits for a new head, or for `stuck-behind` runs `update-branch` again. The gate opens only when no notice was sent, and its prompt names why. `approve-merge` is unchanged.
- 113189a: `serve` stamps each stderr log line with its ISO time, and `/health` adds `startedAt`, `uptimeSeconds`, `restartCount`, `uncleanStartsTotal` and `restartsToday`. The counts persist in `serve-starts.json` in the serve state directory; a start that finds a stale daemon pid file counts as unclean, and a start refused because a server already runs is not counted.
- 31966c4: A failed Shepherd run's `workflow_run.error` now starts with a closed failure class, `[ci-timeout]`, `[gh-api-5xx]`, `[land-rules]`, `[update-branch]` or `[other]`, added at the `shepherd-pr` workflow boundary (TP-2091). `titan-factory shepherd stats --failures [--json]` counts failed runs by class per repo and ISO week, and classifies older unprefixed rows from their text with the same `failureClassOf`.
- d4e3c95: Report time per stage. `shepherd status` shows each live PR's stage (queued, ci, review, re-review, hold, land), the minutes in it and the minutes since registration, as `stage` and `totalMinutes` in `--json`. `shepherd stats` adds, per repo and ISO week, the median, p90 and maximum minutes per stage, including re-reviews after a head move, as `stageTimes` in `--json`.
- 23082f9: A Shepherd registration with merge `owner-gate` must name `ownerGateReason` (`gate-2-visual`, `g10-security`, `proof-fixture` or `owner-asked`) or it is refused with exit 65. The reason is stored in the effective policy and shown in the approve-merge gate prompt. `proof-fixture` runs stay out of the digest's owner-round asks; `shepherd status` still lists them. Runs registered before the field replay unchanged.
- 786d3bd: Keep an append-only `shepherd_event` history (migration 16) of hold, release, freeze and thaw, written in the same transaction as each state change, and show it in `shepherd timeline`.
- 08a2b51: Record `ownerOverride` on a Shepherd run when an owner answer or a seat reviewer overturns a MERGE verdict, and add the weekly override rate per repo to `titan-factory shepherd stats`.
- 7f4e467: `shepherd stats` reports `redAfterMerge` per repo and ISO week: merged runs, those whose stored `sh-main-ci` read was red, the rate, and the red PR numbers in `--json`. Resync and serve's 5-minute sweep mark a merged run `sh-reverted`, with the reverting sha, when a later main commit reverts its merge, reading main once per repo; stats counts those too.
- 582c9c8: Shepherd seats can list `visual_paths` globs. Such a seat merges a pull request without the owner when, at the head being decided, no changed file matches a glob and `MRG-AU-RV` holds (reviewer `MERGE` at that head plus green required checks). A head that changes a visual file gates on `visual-path` and names the files. A changed-file list that failed to read or was truncated gates on `files-unread`. A remote shared by several seats gets the union of their globs. Seats without `visual_paths` are unchanged.
- 734fdb9: Every gate the factory opens now carries a summary naming the head, an evidence link and, where the answer is a choice, a question menu built from the same option list as the answer schema (TP-1198). The host requires a brief (`requireBrief`) after running the gate brief migration at version 13, so a gate site without one fails its run with `GateBriefInvalid`. `titan-factory` prints the summary, evidence and recommended option for a pending gate, and falls back to the prompt for a gate opened before the migration.
- 59ba612: `parseVerdictBlock` reads an optional `Closer: yes|no` line directly after Head on a FIX_FIRST block and returns it as `closer`; absent, on MERGE, malformed, duplicated or misplaced it stays undefined and the block parses as before. Shepherd carries `closer` on a FIX_FIRST verdict and opens approve-merge with the new `no-progress` escalation at the second consecutive FIX_FIRST that said `Closer: no`, before the `fix-first-runaway` cap. Any other round resets the streak.
- 90cbb52: serve keeps a deploy alarm: `/health` and `shepherd status --json --deploy` carry a `deploy` block (running sha, green-merge deploys asked for that have not landed and how long the oldest has waited, refusals in a row, last refusal reason with a stale `.git/index.lock` report), and the configured `shepherd.hubSeat` gets one agent-chat message when the alarm goes up.
- a2b3601: `service check` reports two new causes after `GitHub down`: `stale index.lock`, naming the service checkout's `.git/index.lock` by path and age when no process holds it and it is older than 10 minutes (it is never removed), and `deploy stalled`, naming the deploy alarm's causes and the last refusal reason.
- 8804218: `titan-factory shepherd waiting [--json]` lists every pending gate oldest first (gate, repo and PR, head, task, age in hours, held reason), the gates the owner answers apart from seat work (`ci-failed`, `sh-sent-back`, `stuck-behind`). Each gate says whether the head it names is still the run's head (`headIsCurrent`), the verb exits 1 when an owner gate is over 24 hours old, and the digest lists the five oldest owner gates. It reads the same rows as `shepherd status` and writes nothing (TP-2084).
- dff6a47: The factory digest gains a Flow section: task-to-merge p50 (from a task's `created` date to its Shepherd run's merge, for runs merged in the window) and merges per implementer slot-hour (merged runs over implementer, implementer-lite and bd-implementer hours from the broker roster, each span clipped to the window). A run with no task, or whose task cannot be read, counts as missing and is never imputed The rate is withheld ("not measured") while the roster gives no end time for a non-live implementer, so it never counts only the agents still running (TP-2092).
- 2e83beb: Shepherd's hold wait, gone sweep and release sweep read the per-repo PR snapshot instead of polling each run, so 20 held runs make no per-run `getPr` calls. The snapshot tick slows from 60 s to 5 minutes while `rate_limit` shows under 1,000 calls left, and `/health` reports it as `snapshotTick`. Every write still re-reads its PR first.

### Patch Changes

- be80106: `titan-factory shepherd register` tells a refused connection from a serve that is busy: it waits up to 20 s (two tries) for `/health` before exiting 69, and the message says whether the connection was refused or the serve did not answer. Serve logs a `shepherd.register` that took longer than 5 s.
- efa8342: `service check` polls /health twice more, about 3 s apart, before it reports a live job pid as a stale pid, and the message names how many probes failed.
- 43d95e8: Count compound Bash commands toward the review depth floor: `cd <dir> && grep ...`, `VAR=x && git -C <dir> diff`, and `pnpm exec vitest` now show a reviewer read the change, while sessions with only `cd`, `echo`, `git fetch` or `rm` still do not.
- cf9009e: A Shepherd wake no longer opens the owner `sh-sent-back` gate when the implementer cannot be woken (TP-1751). A retired implementer is never resumed, and a resume agent-chat refuses falls back to a successor spawn in the same wake, under the spawn load gate. A refused successor at a FIX_FIRST or NO_REPRO send-back holds the run: `sh-wake-implementer` records the refusal with `held`, then the repo's seat is told through `sh-exit-notice` and the run waits for a new head, or, when no notice is sent, `sh-sent-back` opens naming the refusal. The watch row's next action and the timeline's wake entry (a new optional `held` field) name the refusal, and the row says the seat was told only when a sent notice follows that wake. A ci-red or conflict wake records no `held` and keeps its `ci-failed` gate or `not-mergeable` stop, and only agent-chat's refusal (`DispatchError`) falls back or holds. Each wake still spends one repair, so the repair budget caps them as before.
- 50d9057: Shepherd's frozen-main wait now ends after an hour so the run reads CI and decides again. It also rechecks main every five minutes while reads of the PR fail. After a thaw it updates or reruns the same red head before spending a repair on it, and a freeze store that throws inside the hold wakes the run instead of failing it.
- 030df30: Notice a push while a Shepherd run waits: a merge step held at a head the pull request has moved past ends with no merge, so the run takes CI and review at the new head and meets the same hold there, and resync answers such a step for a run no runtime holds. A `stuck-behind` gate whose head moved is superseded like the other head gates.
- 6b0c818: Land a PR on a repo whose default branch requires no status checks. `land-rules` no longer refuses it: `ci-wait`
  waits on every GitHub Actions check-run at the head and lands only when there is at least one and all are complete
  and green. Zero runs wait and time out, a red run is red, and another app's runs neither count nor block.
- 4a516ed: Shepherd acknowledges a red, cancelled or missing main CI read at a merge sha by itself once a main commit containing the merge is green on every required context of the base branch. The `sh-main-ci` result records that commit as `acknowledgedSha`, and no main-red or main-ci-timeout gate opens. A red with no such commit within a fresh 60-minute wait still freezes the repo, files a fix task and spawns a fixer, or asks the owner, as before.
- c0d6466: A Shepherd merge whose evidence read `mergeable_state` as `unknown` on all three reads no longer opens approve-merge at once. The land core records a `merge-settle` step and waits with backoff (0 s, 30 s, 60 s, 120 s, then 180 s). It re-reads CI, then reads the merge evidence again at the same head and decides again. A head push during the wait restarts the wait at the new head. The first-unknown time is stored in the step record, so a restart or replay keeps it. A blocking state gates at once. After 30 minutes at one head the gate opens. Its reason names how many minutes the head was unsettled and the result of a local `git merge-tree` of the head onto the base tip.
- 67acbd5: Carry a reviewed MERGE across a clean merge-up of main and release a `g10-review` hold at the new head. A tree-equal carry now needs the new head's first parent to be the reviewed head, its second parent on the base branch and its tree the clean merge-tree of the two; the run log records it as an `sh-merge-up` step, and `sh-g10-release` releases on the reviewed head's opus MERGE once checks are green at the new head. A `g10-adversary` hold still waits for the seat.
- e7a4035: Seat Morning queue items and open active-work `needs-decision` tasks are `QueueSource`s from `@titan-design/owner-queue` (`createMorningSource`, `createActiveWorkSource`). The digest's Morning asks now read through the Morning source, with unchanged output. Personal initiatives are left out unless asked for. `overlapReport` names every PR, task, run or gate that items from two sources both name, and says whether merge-by-keys folded them.
- 0251afd: Add owner-queue `QueueSource` adapters for agent-chat's `/api/queue` and the factory's pending hitl gates. A failed or refused read throws a typed `QueueReadError`, and a new `queue-counts` verb prints each source's open items split by kind.
- 7d9a833: Shepherd's merge evidence now counts a PR's changed files only when the PR sits at the evidence head both before and after the list is read. A push in between leaves the files unread for that head, which gates (`files-unread`), so the visual-path and `.github` checks never judge another head's files. A seat's `visual_paths` glob that no repo-relative changed path could match now makes the seat book invalid, naming the seat, the glob and why: leading or trailing whitespace, a backslash, an empty segment (a leading, doubled or trailing `/`), or a `.` or `..` segment, in the glob or in any of its `{a,b}` alternatives, or a fullwidth slash or invisible format character. Such a glob is refused, never normalised.
- 73ccf12: Add the pure owner presence-proof core: the v1 statement schema, `itemsDigest`, and `verifyProof`, which checks an ECDSA P-256 signature over the received statement bytes before parsing and refuses with a typed reason.
- c517313: Shepherd carries a reviewer MERGE, and an approve-merge answer or review-round ship pick, to a head that is the reviewed head plus one merge of the base when git's remerge-diff of that merge is empty or touches only the repo's declared generated files (`generated-paths.json`). Any other resolution re-reviews and re-asks; a security run never carries. The merge evidence and the `shepherd/review` check name the rule that carried: `tree-equal`, `remerge-empty` or `remerge-generated-only`.
- d1deb84: Shepherd records why it dispatched each review on the `sh-review-intent` step. The cause is one of a closed set, such as first review, fix round, merge-up not carried with its reason, kind that does not carry, seat push, retry, hold or owner request. `shepherd stats` counts dispatches by cause per repo and ISO week, `--json` adds `reviewCauses`, and `--rereviews` prints only that section. Runs recorded before this change count as `unknown`.
- a0c4cfe: The Shepherd spawn gate admits a spawn every 15 s while the machine has headroom (load5 under half of buildLoad5, normal memory pressure, few unabsorbed reviews), keeps the 60 s window otherwise, and caps admits at 4 inside any 60 s. `headroomIntervalMs`, `burstMax` and `headroomReviews` are overridable under `shepherd.spawnGate`. A spawn-gate deferral of a review is now a machine hold, so its waiting is spent from the 3 hour hold ceiling rather than the 30 minute busy budget, and a backlog no longer ends reviews as `none`.
- dc8c4a4: Shepherd now supersedes a pending `shepherd-route/failed-rounds` approve-merge gate when the pull request head moves past the gated head, so resync, `resync --dry-run` and the serve sweep return the run to CI and review at the new head, whose failed review rounds count from zero. A route gate for any other reason, such as a conflict or no progress, stays with the owner.
- 513c0cc: Shepherd now supersedes a pending shepherd-merge-guard approve-merge gate (visual path, unread files, unknown required checks, head mismatch) when the pull request head moves, so resync and the serve sweep return the run to review at the new head instead of leaving the old-head gate pending.
- 6c93045: ci-wait no longer reads a superseded cancelled run as red. When a newer run of the same check exists on the head, the older cancelled run is ignored, so a newer queued run reads pending and a newer success reads green. A cancelled run with no newer run of its name stays red.
- 70baa5c: A thaw listener that throws is logged and no longer throws from the freeze store's release or stops later listeners. A thaw sweep that cannot read a PR head keeps the repo queued for the next sweep tick.
- d1204e8: When update-branch returns but the PR head has not moved within the wait, land re-reads the PR and re-sends the update, up to two times. A head that still has not moved ends the run with the named stop `update-branch-unmoved` instead of a generic step failure.
- 37ef1c9: Import the reviewer briefs from `@titan-design/review-panel` and delete the local copies.
- d4722b2: The `sh-await-verdict` step result now records `reviewerProfile`, the profile of the reviewer whose message it accepted, on MERGE and FIX_FIRST alike. Shepherd's own reviewer gets the profile it was spawned with. An external hold reviewer or a seat reviewer gets the profile the agent-chat roster lists for it. When neither source names a profile, the field is left out. Before this change the profile was only added to the in-memory verdict after the step had been recorded, so no stored verdict ever had it.
- d1c1a50: Stop a Shepherd run as `update-branch-unmoved` when the update after a freeze thaw never moves the red head, as `land` does, instead of reading it as an unchanged head and spending a repair on main's old failures.
- 944ef91: Shepherd judges a main commit by the base branch's required contexts (rulesets, then classic protection, with per-context app pins) instead of every Actions job. A red non-required job such as `release` records a warning and no longer freezes the repo; a repo with no rules, or a rules read that fails, keeps the all-checks rule. The github port gains `classicRequiredChecks` and `RequiredChecks.pins`.
- 7967c9f: Add a pure decision for which approve-merge gates a submitted review round answers: a ship pick at the gate's exact head resolves a seat or MRG-AU gate, and every other case stays pending.
- 7094504: Shepherd no longer opens a main-red gate for a backlogged main run. At the wait limit it reads the newest completed main push containing the merge, and re-checks up to 3 more windows while a run is still queued or in progress. When no completed run contains the merge it opens `main-ci-timeout`, naming the missing run, so a backlog is not read as a red.
- 8478d0c: Shepherd's `sh-cleanup` now cites the merged PR and merge sha in the task's notes before it marks a non-slice registration's task done, and records why a task stayed open when active-work was unreachable.
- 4ea51f9: `shepherd register --task <ID>` with no initiative now resolves the ID through the active-work task index, or exits with a usage error naming `--task <initiative>/<ID>` when no single initiative owns it. A bare ID could never be closed at cleanup.
- e8d4be6: Shepherd sets aside a reviewer's MERGE or FIX_FIRST when the reviewer's session made no investigative tool call (Read, Grep, Glob, or a Bash read verb such as `git diff` or `gh pr view`). The review ends as no-verdict and routes to a fresh reviewer within the existing caps.
- 1dafa83: A successor Shepherd spawns on a wake is now told whom to report to: the earliest session that spawned an agent in the PR's lineage. Shepherd spawns through the agent-chat CLI as the human, so the broker appends no return contract, and a successor left to guess once reported to an unrelated seat. When the human started the whole lineage, the brief tells the successor to message no session.
- a4b0cf7: Read a reviewer whose final message is Claude Code's usage-limit notice as "hit the usage limit" rather than a malformed verdict: Shepherd no longer spends a correction turn on a session that cannot answer, and the step reason names the limit.
- 34066da: Land retries update-branch with a growing wait (three extra rounds, each a recorded `update-backoff` step before an ordinary `update-branch` step) before it opens a stuck-behind gate; the gate reason names the retries.
- 4060479: The owner digest lists each pending gate as one ask with its summary, evidence and resolve command, marked waiting since its open time when it was already pending at the window start; two gates on one PR stay two asks.
- cf3b0d0: Build the reviewer brief's checkout-removal path from `reviewCheckoutName`, and give Shepherd one home each for its home-path prefixes and its run policy ceiling. No behaviour change.
- dcde08d: Shepherd's merge facts bind `shepherd/review` to the configured `shepherd.reviewCheck.appId` through `contextApps`, so a required `shepherd/review` passes only on the Shepherd App's success at the head and a GitHub Actions job of that name no longer counts. With no App configured the context has no counting app and gates; every other context still counts from GitHub Actions only.
- c519845: Shepherd's wake step now gives up on a live implementer's PR that keeps failing to read. After the same give-up main-red allows a GitHub read, it returns `unhandled` naming the PR and the last error, so a permanent 404 or 401 opens the owner gate instead of polling silently. A successful read restarts the clock.
- 4c1b3ad: A Shepherd reviewer whose final message passes every identity check but holds no readable verdict block now gets one correction turn in its own session: the new `sh-correct-verdict` step resumes the exited reviewer with the correction prompt, and the reply is read as `sh-await-verdict:<head>:corrected`. A second malformed reply, or a reviewer that cannot be resumed, still goes to a fresh reviewer.
- a279f1d: A woken Shepherd fixer that exits without pushing a new head no longer leaves the run waiting for one. When every failing test file is outside the PR's diff, the failed jobs are rerun once at that head; otherwise the sent-back gate opens naming the fixer's exit.
- 9e56a96: The head and thaw sweeps no longer cancel a conflict, escalation or route gate that asks about the same head as the run's last MRG-AU or seat decision. Such a gate is answered by `conflictGate` without a recorded cancel, so the cancel failed the run. A decision now reads as the gate's only when the prompt names its policy table (TP-1752).
- ed09d59: Document why a merge conflict that survives one fixer attempt opens the owner's approve-merge gate, and list Shepherd's five escalations in the README.
- d4db9bc: Shepherd sizes a PR before it spawns the reviewer: over 400 changed lines, generated registry files left out, the PR gets the g10 profile. `shepherd.review.g10ChangedLines` overrides the limit. A size it cannot read (truncated list, missing counts, failed read) takes the g10 profile.
- c277dca: Shepherd's spawn gate now admits the review of a red main's fix PR before any other waiting review. While that review is still asking (within twice the longest busy wait), the gate refuses every other review spawn with a reason naming it; implementer, successor and fixer spawns are unaffected. `shepherd status` names a gated review's place in the queue, for example "waiting for a spawn slot, position 2 of 3".
- ff6424a: A Shepherd run replayed after a serve restart now follows the route its record took after each review, so a route table changed by a redeploy no longer sends it back to review or publish at a head it already left. Resync answers an active reviewer-starting step whose head the PR has moved past, and supersedes nothing when the PR cannot be read (TP-1831). The workflow context gains `historyNext()`, and the runtime gains `completeStep()` for a run no runtime holds.
- e7e558b: After a red ci-wait, Shepherd's wait for the fixer's new head also re-reads the required checks at the unchanged head on each poll. When a rerun of the failed jobs turns them all green, the run leaves `sh-await-new-head` and collects merge facts at that head, with no new commit. Waits after review and conflict wakes are unchanged.
- 6e8f589: `titan-factory service check` runs on Linux: it reads `systemctl --user show` (MainPID, NRestarts, ExecMainStatus) and reports a crash loop or a dead unit with the same exit codes as on macOS.
- 4b81630: Shepherd's reviewer brief and fix-round brief now tell the agent to run only targeted tests on the Mac and the full suite with `ssh basement basement-suite`, never a full `pnpm test` locally.
- 0fca60e: Shepherd hands a FIX_FIRST fixer every FIX_FIRST the reviewer wrote for that head that has findings, in order and without repeats. This applies to its own reviewers, hold reviewers and seat reviewers, so a later postscript restating the block no longer replaces the findings. Findings over the cap are cut from the start, so the newest survive, and the structural brief reads the newest defect class. A verdict with no findings says so in the wake and points at the recorded verdict step.
- 78b8a99: Add `readChecksPolicy` and `checksDrift`: read the committed `.github/required-checks.json` at a PR's base ref and diff its contexts with the live required checks. An absent, malformed, unknown-key, unlisted-branch, empty or blank-context file reads unreadable, never as "no policy". Nothing calls them yet.
- 20778a2: Stop gating `.github/` changes in Shepherd's merge guard; they auto-merge like any other PR (owner decision of 2026-10-07, TP-1886).
- 2251fe3: Treat an approve-merge gate as npm-blocked only when its prompt names the shepherd-release preflight-blocked policy row, so a conflict gate at the same head stays pending for the owner.
- 986ea90: A fixer woken for FIX_FIRST or ci-failed that exits with no new head now gets its repo's seat one agent-chat message per run and head, instead of the owner's `sh-sent-back` gate. The message names the PR, head, round, wake mode and the agent's last report. The new `sh-exit-notice` step records whether the agent exited before reading a live wake (`unread`) or read it and pushed nothing (`read-no-push`). The gate still opens if the send fails, no single seat owns the repo, or the agent exits again at the same head.
- a494d85: Add a Shepherd handoff port for workflow steps. `handoffRef(services)` registers a PR through the `shepherd.register` command, idempotent per repo#pr, and reads a run's status with `landed` or `stopped` and the merge sha from its `sh-landed` or `sh-stopped` step. `FactoryRoutes.bindHost` lets `openFactoryHost` bind the port to the host it opens and unbind it on close; an unbound port throws `handoff not bound`.
- Updated dependencies [378021d]
- Updated dependencies [cb137e3]
- Updated dependencies [2ff0840]
- Updated dependencies [69db518]
- Updated dependencies [c517313]
- Updated dependencies [f88ac00]
- Updated dependencies [f320219]
- Updated dependencies [490489b]
- Updated dependencies [944ef91]
- Updated dependencies [5facf32]
- Updated dependencies [7f4e467]
- Updated dependencies [501b7c2]
- Updated dependencies [b97a26d]
- Updated dependencies [116dd59]
- Updated dependencies [69db518]
- Updated dependencies [cff7a11]
- Updated dependencies [bc96ab3]
- Updated dependencies [484fadc]
- Updated dependencies [7313f6b]
- Updated dependencies [e963a49]
- Updated dependencies [45f05b1]
- Updated dependencies [d3e5f57]
- Updated dependencies [a18ef2a]
- Updated dependencies [37ef1c9]
- Updated dependencies [d4722b2]
- Updated dependencies [0a58927]
- Updated dependencies [f88ac00]
- Updated dependencies [f34ae27]
- Updated dependencies [495e6f8]
- Updated dependencies [74f9f51]
- Updated dependencies [a8faac4]
- Updated dependencies [1aed39d]
- Updated dependencies [1fd9652]
- Updated dependencies [deb35d0]
- Updated dependencies [295acf8]
- Updated dependencies [1f7de27]
- Updated dependencies [cf3b0d0]
- Updated dependencies [dcde08d]
- Updated dependencies [59ba612]
- Updated dependencies [d4db9bc]
- Updated dependencies [d4db9bc]
- Updated dependencies [ff6424a]
- Updated dependencies [1cb05e7]
- Updated dependencies [20778a2]
- Updated dependencies [ff6ff86]
- Updated dependencies [ff6ff86]
- Updated dependencies [f8b7be1]
- Updated dependencies [bf5cd2a]
- Updated dependencies [4c1c075]
- Updated dependencies [5b53b87]
- Updated dependencies [37c2689]
- Updated dependencies [3c5b114]
- Updated dependencies [c466784]
- Updated dependencies [d4ef157]
- Updated dependencies [d186dfb]
- Updated dependencies [7f4e467]
- Updated dependencies [34066da]
- Updated dependencies [534cec8]
- Updated dependencies [2159a49]
- Updated dependencies [9784293]
- Updated dependencies [d251acb]
  - @titan-design/agent-dispatch@0.5.0
  - @titan-design/app-paths@0.1.0
  - @titan-design/authority@0.4.0
  - @titan-design/daemon@0.5.0
  - @titan-design/github@0.6.0
  - @titan-design/hitl@0.8.0
  - @titan-design/owner-queue@0.1.0
  - @titan-design/registry@0.3.3
  - @titan-design/review-panel@0.1.0
  - @titan-design/rpc-client@0.3.0
  - @titan-design/session-read@0.11.0
  - @titan-design/store-sqlite@0.4.0
  - @titan-design/workflow@0.10.0
  - @titan-design/worktree@0.1.5

## 0.8.0

### Minor Changes

- 49db03d: Shepherd publishes a `shepherd/review` check run per head through a new `sh-publish-review` step: `success` only for a MERGE at that exact head or carried to it across a verified tree-equal update, `failure` for FIX_FIRST, and `action_required` for every other outcome, including a moved head, which is posted at the new head. The App comes from the optional `shepherd.reviewCheck` config (`appId`, `installationId`, `privateKeyPath`); without it, or when a post fails, the step records `published: false` and the run continues.
- 827a363: On Linux, `titan-factory service install`, `status`, `uninstall`, `restart`, `deploy` and `plist` manage the systemd --user unit `titan-factory.service`, the launchd plist's twin (TP-1835). `service install --dry-run` prints the file and the calls install would make. macOS behaviour is unchanged, and `service check` still needs macOS.

### Patch Changes

- c110a59: The spawn gate counts only live reviewers and adds review load only for reviews younger than load5's window (TP-1770).
- fa24af1: A review that never started because every spawn was deferred now returns to review intent on a behind head too, instead of going to the merge decision and opening an approve-merge gate. The wait names reviewer admission.
- 82ae970: The spawn gate reads free memory and PSI memory pressure from /proc on Linux, with the same thresholds as agent-chat's machine guard (TP-1778).
- 7776398: Merge policy's freeze read and `shepherd resync` now re-read the default branch through the freeze guard's green-after-red recheck, sharing its five-minute per-repo limit, so a main fixed outside Shepherd thaws a stale freeze without an owner gate. A failed read leaves the repo frozen.
- Updated dependencies [179706a]
- Updated dependencies [9891e0d]
- Updated dependencies [f2e4abf]
- Updated dependencies [6a2c0f8]
- Updated dependencies [816d492]
  - @titan-design/daemon@0.4.1
  - @titan-design/github@0.5.1
  - @titan-design/hitl@0.7.0
  - @titan-design/session-read@0.10.0
  - @titan-design/worktree@0.1.4
  - @titan-design/workflow@0.9.1

## 0.7.0

### Minor Changes

- ebbc2a5: `shepherd timeline` gives each `sh-await-verdict` result a `verdict` entry (MERGE, FIX_FIRST or none, with its head, reviewer and transcript span) and each `sh-wake-implementer` or `sh-wake-fix-first` record a `wake` entry, where it listed them as plain steps before. A record that does not parse stays a `step` entry. In the `wake` entry, `request` and `outcome` are now nullable because an implementer wake records no request and the FIX_FIRST counter records no outcome, and `mode` also accepts `live`, which Shepherd already records for a wake sent to a running session.
- 25e64e8: Shepherd's sh-review adds up to 3 questions from the head's `codewatch-report` artifact to the reviewer brief, for repos listed in `shepherd.review.codewatchRepos`. The step records `codewatch: { found, schema, questions }`. A missing artifact, a wrong schema or a failed fetch adds no questions, and the review proceeds.
- 92e76c5: Add a per-repo PR snapshot that `ci-wait` and `sh-observe` read instead of polling GitHub per run. It revalidates each repo's open-PR list once a minute with its ETag. It reads check runs only for a new head, or for a head whose counted checks are still running; the snapshot uses the same check set as the CI verdict. The snapshot may answer pending, red or behind, but `readCi` confirms a green through the port before returning it. Every write still re-reads its PR, and the snapshot is dropped after a write. The production routes wire it in; `LandDeps.snapshot` is optional, so a caller without one reads the port as before.
- 0f63528: `gate resolve` in a shell agent-chat launched asks for owner presence before it resolves as the owner. A confirmed dialog resolves as `owner-terminal` with the proof id as `confirmEvent`; no proof resolves as `coordinator`, named by `AGENT_CHAT_NAME`, which hitl refuses. The dialog reason is built only from a gate id, decision and head sha that pass strict shapes, and a proof must be a v4 UUID. The owner-presence helper now builds into `native/build`, outside `dist`, so `pnpm build` no longer deletes it. `resolveGate` is async.

  After this release, rerun `pnpm factory:install` (or `node scripts/factory-build-helper.mjs`) on the machine. `service deploy` only installs and builds, so it leaves `native/build/owner-presence` missing, and until the helper is compiled every resolve from a shell with `AGENT_CHAT_AGENT_ID`, including the owner's `!` command, is refused as `coordinator`. The dialog does not yet stop an agent that only runs the CLI: `env -u AGENT_CHAT_AGENT_ID` or an empty value still resolves as `owner-terminal` with no dialog, until the owner decides whether every resolve asks for presence.

- bf6b089: `LandOutcome`'s merged `mergeSha` is now `string | null` instead of `""` when GitHub names no merge commit. The post-merge chore then runs with `LAND_PR_MERGE_SHA` unset.
- b09ac37: The Shepherd reviewer brief for a run that will reach the owner asks for an OWNER-BRIEF block (what, why, pros, cons, door type) after the verdict. The reader parses it into a typed `ownerBrief` on the sh-await-verdict output; a missing or malformed block is `null` and never changes the verdict.

### Patch Changes

- 0ae0123: `listAgents` now returns a promise and reads the roster through the new `execSafeAsync`, so a slow `agent ls --json` no longer blocks the caller's event loop; the Shepherd roster reader awaits it.
- 18e081a: Read `Verdict: WAIT` (required checks unfinished at the reviewed head) as no verdict, never a MERGE. `parseVerdictBlock` returns `{ ok: false, reason: "wait" }` with the PR and head the block names; Shepherd's `acceptVerdict` returns `none` with reason `wait`, and a seat reviewer's WAIT at a head never reads clear for a carry or a MERGE.
- ef47e80: Keep a Shepherd run waiting, up to three times the ci-wait timeout, when the timeout passes with its checks only queued or in progress, and end with a reason that names the CI backlog.
- 86aae44: A seat-driven fix no longer needs an owner gate answer to get going again. `shepherd register` on a pull request whose run ended stopped `not-mergeable` or on a `conflict`, with the pull request still open, starts a new run at the current head and reports `previousRunId` and `previousStop`. A live run, a merged run, and a run stopped for any other reason come back unchanged. A pending `ci-failed` gate is superseded once the pull request moves past the red head it asks about, by the serve sweep or `shepherd resync`, and the run lands the new head; the supersede is recorded once and replays identically.
- a20a6e3: `@titan-design/daemon` exports `getProcessStartTime(pid)`, which reads when a process started from `ps -o lstart=` in the C locale, or null when the pid has no process.

  `titan-factory service check` no longer reports a crash loop right after `service restart` or `launchctl kickstart -k`: a process under 5 minutes old whose `/health` body names the launchd pid is healthy, even though launchd recorded the killed run's non-zero exit. It reads process start time through the daemon helper instead of its own `ps` parser.

- 05e6ec2: `service deploy` builds again under the pinned pnpm 9: only the install step keeps ignore-scripts, which made pnpm 9 run `build` without `node_modules/.bin` on its PATH. A failed git or pnpm step now records its exit code and redacted, capped tails of stderr and stdout, and a killed or timed-out step says so.
- 0c29aea: The deployer's `pnpm install` honors the checkout's `packageManager` pin and runs with `CI=true`, so it purges a foreign modules layout without prompting. It used to pin `manage_package_manager_versions=false`, so a global pnpm 10 installed a v10 layout that every pinned pnpm 9.15 install then prompted to purge, and with no TTY that prompt exited 0 without installing.
- bb8f81a: Hold a ci-red wake that only repeats a frozen main's failures. With a freeze open on the PR's repo, a red head whose failing checks all fail on the freeze's red sha spends no repair and wakes nobody: `sh-freeze-hold` records why, and `sh-freeze-wait` waits for the thaw or a new head before the next round re-reads CI. A failing check that main does not share, no freeze, or the fixer's own PR wakes as before.
- af23578: Check the owner-presence helper's path with lstat before each run. The helper and every parent up to `/` must be owned by root or the current user, with no symlink and no group or other write bit; otherwise presence fails closed and stderr names the offending component. A root install at `/usr/local/libexec/titan-factory/owner-presence` is preferred over `native/build` when it exists.
- 770fbc6: Shepherd records an error class or HTTP status, never the error's message, in the wake, main-red, post-merge, redeploy, cleanup, resync and Version Packages reasons. A retire refusal for unpushed commits or uncommitted changes is still named, in fixed words. `service install` and `service restart` name the serve error log on a failed health check instead of quoting it, so a post-merge chore that runs `service deploy` stores no error text.
- 85870d9: `WorkflowRuntime.hydrate` takes an optional `exclude` set of run ids to leave unclaimed. Factory serve uses it so a held Shepherd run whose PR read fails is no longer adopted and driven: it waits for the next tick, when a successful read ends it or adopts it.
- 113cac1: Shepherd's seat check on a carried MERGE now reads seat reviewers at every commit the PR passed through since the reviewed head, not only the heads the run reviewed, so a FIX_FIRST at an unreviewed update refuses the carry. An unreadable or short commit list, or more than 50 heads, refuses too. `@titan-design/github` adds `listPrCommits` and `PR_COMMITS_CAP` to the port, wire and fake.
- ef5a4a7: The seat-reviewer transcript reader drops cached transcripts of reviewers that have left the roster, so retired reviewers' messages are no longer held until the process restarts.
- c8a2362: Shepherd decides "this verdict block names the target PR" in one shared predicate that compares the repo case-insensitively, so a reviewer writing `Owner/Repo` satisfies a run registered as `owner/repo`.
- 49ec5cc: Keep the stored kind on a repeat Shepherd registration that omits `--kind`. Before, the repeat reset it to `unknown`, which skips the fix-proof gate. An explicit `--kind` still replaces the stored kind.
- 0f55e8b: Surface the errors Shepherd swallowed. `WorkflowRuntime.cancel` now throws a typed `WorkflowNotOwnedError` (same message) when it cannot claim the run. The gone-elsewhere sweep treats only that error as a lease held elsewhere; any other cancel failure goes to the new `onCancelFailed` callback, which serve logs, resync reports as `cancelErrors` and keeps held, and the pre-adoption recheck keeps unadopted. A `findPr` rejection in the Version Packages sweep is now a `{ repo, error }` note. A reviewer that never starts after failed roster reads names the last roster error in its reason. A thrown review-ruleset read or registration read still gates the merge, and the gate reason now names it (`unreadFacts` on the evidence).
- a1c7c55: Shepherd types agent presence as one `Presence` union (live, detached, exiting, exited, deregistered), and its merge-evidence and verdict-locator step outputs are parsed against their real shape instead of cast.
- 37f51bd: Shepherd's registration lookup no longer writes to the store; releasing a finished run's branch is a separate step, and the finished run statuses live in one shared set.
- 173202c: Type the shepherd text formatters by command name, so a verb with no formatter fails to compile, and parse the await-verdict step input with a zod schema that keeps every error message.
- ca95974: The Shepherd timeline's wake entry now accepts the `fix-proof` request, with its request and mode enums tied at compile time to the wake input kind and the wake step result mode.
- c195acf: Import the shepherd wake-brief helpers from `wake-brief.js` directly and drop their re-export from `wake.js`.
- eefcf0a: Shepherd's post-merge main CI read now carries the newer push sha in the classified read's type, so a route table edit that sends a read with no newer sha to `read-newer-run` fails to type-check instead of polling at "undefined".
- 7b65a2a: The state directory, the settled-run wait and the CLI exit codes each have one owner now: `serviceLogDir` is gone in favour of `factoryStateDir`, the in-process land wait is the host's `untilSettledOrGated`, and `gate resolve` shares `EXIT` and `stepIdMatches` instead of repeating them.
- ea3c64e: Share one cached-probe helper between the /health GitHub and behind-main probes, export `DIRTY_SUFFIX` and `PROBE_PENDING` from build-info, and compare behind-main against the factory's own repo (`unknown` when it has none).
- c2145be: The await-new-head step now fails at once on a 401, 403 or 404 read of the pull request, naming it and the status, instead of retrying a permanent error forever. Transient read failures are still retried and are reported through `onReadError`.
- 625ade0: Derive the land `CiVerdict` type from the land-steps zod enum and drop the duplicate `SettleTiming` interface.
- 9614cdc: Shepherd's reviewer profile now comes from a role table by PR class: a registered `security` kind gets the g10 profile and every other PR the standard one. The optional `shepherd.review.roles` sets them; with no table every class keeps `review.profile`.
- d5446f3: Shepherd no longer reads an unreadable PR as "head not moved" when waking a live implementer: a failed PR read defers the wake one poll, and the next readable read decides whether to message the agent.
- 4266337: Shepherd reviews a PR that is behind its base as soon as its own required checks are green, and brings the branch up to date only on the way to the merge, where each clean base merge carries the reviewed MERGE. The `stuck-behind` gate and outcome now name the update count and every head the updates started from.
- 0a37076: Shepherd counts branch updates per run instead of per land round, so a head that goes behind during a review no longer resets the stuck-behind bound, and a behind head whose mergeable_state is still unknown no longer burns a land round per read.
- b61ec7e: Test only the question text for verdict words in codewatch questions, so a question on `merge-facts.ts` or `await-verdict.ts` is no longer dropped for its path. The codewatch evidence on the review step records a `dropped` count.
- 821d4e1: A held Shepherd run whose PR read answers 404 (deleted PR, renamed or removed repo) now ends as gone instead of staying unreadable forever; the per-tick warning names each unreadable run with its `getPr` error.
- 6a7519a: Refuse an explicit `--kind` on a repeat Shepherd registration that would move a `correctness` run to a kind that skips the fix-proof gate, or a `security` run to any other kind. The refusal exits 65, names the stored and requested kinds, and leaves a failed run untouched instead of replacing it first.
- 4196562: merge-facts records an unreadable Shepherd store in `unreadFacts` as its error class only (`store unreadable: <name>`), never the error's message, so no store error text reaches the gate reason or the public evidence comment.
- ef42dfe: Owner presence now fails closed, naming the error code on stderr, when lstat of the root helper path or a parent fails with anything other than ENOENT or ENOTDIR, instead of treating it as absent and falling back to native/build.
- d902365: Correct the Shepherd docs, comments and kind-move refusal messages that said the registration kind controls the fix-proof gate. The kind controls carried verdicts and the kind-move refusals; no behaviour changes.
- 10d11f2: Shepherd merge-facts reads a thrown error's name once, inside a try, so a throwing or shifting `name` getter still records only a fixed class and still gates.
- fe4badd: Shepherd gate and step reasons record an error's class or HTTP status, never its message: the tree-carry probe, the seat check, the codewatch fetch warning, the reviewer dispatch refusal, the busy-broker waits and the roster error.
- 1968a25: Shepherd keeps one errorClass, in shepherd/error-class.ts: merge-facts imports it, and it refuses an identifier-shaped error name that looks like a credential (a GitHub token prefix, a JWT head or a 32+ hex run). failureOf reports an HTTP status only in 100-599, and the reviewer dispatch's console line no longer fails the step when an error's message getter throws.
- 7d3bd65: The Shepherd PR timeline schema no longer accepts an `evidence` entry. Nothing produced one and no renderer or reader consumed it.
- 29d310b: Shepherd's carry seat check also reads every head force-pushed away since the reviewed head, so a seat FIX_FIRST there refuses the carry; an unreadable force-push list refuses with a fixed reason.
- 4ed86e8: Add `listForcePushes` to the GitHub port: a PR's head force-pushes with the head each replaced and the new head, read through GraphQL on the port's `gh` login, capped at one page of 100 with `ForcePushesTruncated` past it. `fakeGitHub()` seeds them through `fake.forcePushes`. The factory's carry seat check now reads force-pushes through the port, and its product-side reader is deleted.
- c09bcc7: A held Shepherd run waiting in its merge step now names the hold in its next action and no longer trips the merging stall alarm; its phase stays `merging`. A merge waiting at a head that a fix round replaced ends once the hold's reviewer sends MERGE at the new head.
- a685339: `land` stops chasing a moving base where the ruleset does not require it. In a repo without strict required checks, a green head whose base moved after its CI started now reads `behind` with `checksGreen` and `baseMoved`, so Shepherd reviews it first; `land` takes it to the merge decision as is and refreshes it with one update-branch only after the merge is approved, then merges even if the base moved again. In a strict repo, a behind head is updated only once its required checks have settled, so a base move costs one CI run per PR rather than one per move, and the `stuck-behind` gate now opens after at least `MAX_UPDATE_CYCLES` (3) updates and `UPDATE_BUDGET_MS` (120 minutes) since the first update of the bound, timed from the `at` that `update-branch` and the `readAt` that `ci-wait` now record. A recorded run without those times keeps the fixed count of 3. The gate text names the elapsed time and the budget beside the heads.
- c37d19c: Shepherd's merge evidence re-reads a PR whose `mergeable_state` is `unknown` (at most 3 reads, 5 s apart) before judging merge-tree-clean, records the judged state in the evidence record, and gates with `mergeable_state unknown after 3 reads` when it never settles.
- 1d9ea6f: Shepherd no longer leaves an authority/MRG-AU approve-merge gate pending on a stale head or a transient merge-tree read. `shepherd resync` and the periodic head sweep cancel a pending MRG-AU gate whose head is no longer the pull request's head, and `shepherd resync` also cancels one still at the head whose only unmet condition was `merge-tree-clean`. The run then starts a new cycle at the current head and reviews it again, so its facts are read afresh. The gate is only ever cancelled, never resolved, so the owner stays its only resolver. Release, guard and route gates, and any rule other than authority/MRG-AU, are left alone; a seat or registration owner-gate gate is still superseded only when its head moves, as before. `shepherd resync` prints one line per superseded gate naming the run, the old and new head and the condition.
- c632d92: `titan-factory service check` reads agent-chat's `burndown-status.json` and reports `tick failing` (one or more consecutive failures, with the file path, count and class) or `tick stale` (heartbeat older than three times its `intervalSeconds`). An absent file leaves the check unchanged, and a server cause is still reported first.
- f4baa96: A strict behind head whose required check has never reported (a workflow that exists only on the base) now settles after a 10 minute grace, so land updates the branch and starts the workflow instead of waiting out the ci-wait timeout. A check that is queued or running still blocks the update.
- 1016a1c: Shepherd's `acceptVerdict` records why a reviewer's final message was no verdict, as `malformed: { refusal, writtenAt }` on its `none` result, and `correctionPrompt` builds the one-turn correction message from code-chosen text only. Nothing reads the record yet.
- 7fb6a9b: A coordinator may now resolve a `stuck-behind` gate with `{"decision":"retry"}`, recorded with its agent name. Abandon, every other gate and every other non-owner class stay refused.
- e5d1405: Shepherd's main-CI read no longer counts a check run that workflow concurrency cancelled as red when a newer run of the same check on the same sha superseded it; a lone cancel waits instead of freezing. A freeze records whether its red came only from cancelled runs, and only such a freeze may thaw at its own red sha once each check's newest run there is green (migration 12 adds `shepherd_freeze.cancel_only`).
- 8d29464: Shepherd supersedes an MRG-AU approve-merge gate whose only unmet conditions were transient (`merge-tree-clean`, `repo-not-frozen`) once the repo is no longer frozen, both in resync and, under `serve`, as soon as a freeze thaws, so the run asks the policy again at the same head.
- f20ceda: Shepherd's main-red fixers and wake successors now spawn under the headless `bd-implementer` profile instead of the builtin `implementer`, which opened an iTerm pane nobody watches. Both paths share one `FACTORY_IMPLEMENTER_PROFILE` constant; the `FIXER_PROFILE` and `SUCCESSOR_PROFILE` exports are gone.
- 191ac81: Shepherd's merge policy reads `repo-not-frozen` as met for a frozen repo's own fix PR (the PR registered against the freeze's fix task by its fixer), matching the freeze guard that already lets that PR land; every other PR in the repo still gates. Resync supersedes a pending approve-merge gate on that fix PR whose only unmet conditions are transient, while the repo is still frozen.
- 1888242: Shepherd's own reviewer, fixer and successor spawns now pass a machine gate (load5, memory pressure, free memory, one admission per window) before agent-chat is asked to start them; a refused admission defers and is retried on the next poll. Limits come from `shepherd.spawnGate`, defaulting to the seat values.
- 82a7ad0: The restart drain no longer waits for a Shepherd run held in a merge step: it cannot merge until released, so a restart repeats nothing. `/health` lists such runs under `heldSkipped`, and the drain names them.
- b217eac: Shepherd reads the new head in the round after a wake. `await-new-head` drops the repo's PR snapshot once it sees the new head, so the next `ci-wait` and `sh-observe` no longer read the old head as behind and wake the fixer again. A wake at a head that an earlier wake already saw replaced now waits for a new head and does not spend a repair.
- Updated dependencies [0ae0123]
- Updated dependencies [18e081a]
- Updated dependencies [a20a6e3]
- Updated dependencies [c8ab11b]
- Updated dependencies [92e76c5]
- Updated dependencies [ea96b66]
- Updated dependencies [218cbac]
- Updated dependencies [85870d9]
- Updated dependencies [113cac1]
- Updated dependencies [27702c6]
- Updated dependencies [f886302]
- Updated dependencies [0e67551]
- Updated dependencies [0f55e8b]
- Updated dependencies [041125d]
- Updated dependencies [6385c70]
- Updated dependencies [f0db7a9]
- Updated dependencies [170ed76]
- Updated dependencies [13e505a]
- Updated dependencies [fe4badd]
- Updated dependencies [6b19eac]
- Updated dependencies [10a66c3]
- Updated dependencies [4ed86e8]
- Updated dependencies [d10a591]
- Updated dependencies [7fb6a9b]
- Updated dependencies [2dbbb38]
  - @titan-design/agent-dispatch@0.4.0
  - @titan-design/session-read@0.9.0
  - @titan-design/daemon@0.4.0
  - @titan-design/github@0.5.0
  - @titan-design/store-sqlite@0.3.3
  - @titan-design/workflow@0.9.0
  - @titan-design/hitl@0.6.0
  - @titan-design/worktree@0.1.3

## 0.6.0

### Minor Changes

- 32adb30: Add the `verdict-merge-carried-tree-equal` and `pr-kind-not-security` conditions and a separate automation row, MRG-AU-RC, that lets a MERGE verdict carry to a tree-equal head. It keeps every MRG-AU-RV condition except `verdict-merge-at-head`, which stays unchanged, and never carries `kind: security` or an unknown or missing kind. `MergeFacts` gains optional `carry` and `kind` facts. Shepherd's merge-facts collector fills `carry` only from the `sh-carry` step output and `kind` only from the run's registration.
- 5f2d5e0: Shepherd reuses a reviewer's MERGE across a tree-equal update-branch. At a new green head of a correctness, feature or refactor PR whose newest verdict is a MERGE, the `sh-carry` probe asks whether the head is exactly that reviewed head merged cleanly onto main; on equal the head takes a carried MERGE (merge evidence with the carry fact, and a comment naming both heads and trees) and no reviewer is dispatched. A hold satisfied by its named reviewer's MERGE moves to a tree-equal update the same way. A FIX_FIRST or other non-MERGE newest verdict, a security PR, or a PR with no registered kind never carries. Adds the `sh-carry-scope` step and a `carry` option on the review wiring for the probe's git.
- a2b4bfc: Add `confirmOwner(reason)` and a Swift owner-presence helper built by `pnpm factory:install`. The helper shows the macOS Touch ID or login-password dialog and prints a proof id; cancel, a missing helper, an error and no GUI session all return `undefined`. Nothing calls it yet.
- 3494b20: Add `titan-factory service check [--port <n>] [--json]`: a read-only diagnosis that exits 0 when `/health` answers from the launchd pid with `github` ok, and otherwise prints one line naming the first cause (not loaded, stale pid, crash loop, stale build, GitHub down).
- 2ea65db: Resync Shepherd at every `titan-factory serve` start, before the first adoption: end each live shepherd-pr run whose PR was merged (`landed elsewhere: `) or closed (`closed elsewhere: `) outside Shepherd, cancel pending gates of runs that already ended, and supersede moved-head gates once. A run that recorded its own `merge`, `sh-landed` or a post-merge step is never ended this way, even when it records one while its pull request is being read: the run is read again after the read and cancelled in the same tick. This also stops the 5-minute sweep from cancelling a post-merge gate. Adds the `shepherd.resync` command and `titan-factory shepherd resync [--dry-run]`, and the `resyncOnStart` server option.

### Patch Changes

- 02c5d99: Count Shepherd's review wait deadline and exit grace from the reviewer session's start (the dispatch time when no start is recorded), so a restart no longer gives a review a fresh 30 minutes. A restart 25 minutes after the reviewer started leaves it 5 minutes; a reviewer already exited past its grace ends the wait at once. A detached reviewer keeps its 10-minute grace from first sight.
- e6512c2: List every kind of agent factory dispatches in its CAPABILITY.md: reviewer, main-red fixer, successor implementer, and the detached deployer.
- f02c4bb: Add `shepherd.flakyChecks`, a per-repo list of required-check names and a wait in seconds. When every failed required check is on the repo's list, `ci-wait` reruns the failed jobs once per head after the wait, before any wake; an unlisted failure, or a second red after the rerun, wakes as before.

  The flaky rerun re-reads the head and run after its wait and skips a moved or replaced run, spends its budget only when GitHub accepts the rerun, and `waitSeconds` is capped at 900.

- 92cc2ea: Shepherd reaches agent-chat through one adapter. A wake successor now spawns under the configured `shepherd.fixer.configDir`, as the fixer does, instead of the default Claude account.
- 7e2ce6d: Tell Shepherd reviewers to remove their `$TMPDIR/review-*` checkout after the verdict, and sweep any such directory older than a day at serve start and hourly.
- c5a341a: The Shepherd review-checkout sweep skips a bad entry and carries on, removes only real review-\* directories (never files or symlinks), and the reviewer brief names the literal checkout path to remove.
- 92a7d8b: The review-checkout sweep now matches only `review-<pr>-<12 hex>` directories instead of any `review-*` name in the temp dir. It removes them with async `fs/promises` calls so the daemon loop is not blocked, and `serve` logs a warning with the path and message when an entry cannot be removed.
- 3929589: Shepherd rechecks runs that start resync could not cancel (a live foreign lease) against their PR right before adoption, so a run whose PR merged or closed outside Shepherd is ended instead of driven to sh-landed.
- 76d4c43: Shepherd cleanup re-reads the agent roster fresh just before retiring, so an agent resumed inside the roster cache window is no longer retired.
- 3e418cc: Shepherd cleanup's caveat now says the roster was unreadable when the fresh read right before a retire fails, instead of "not seen exited".
- 9c2ea6d: Shepherd waits out a machine hold without escalating. A broker refusal coded `machine_hold` is a `ReviewerMachineHold`, and the time it holds is spent from its own 3 hour ceiling (`DEFAULT_HOLD_WAIT_MS`) instead of the 30 minute busy wait. The wait note reads "held by the machine stop".
- 295c5df: Shepherd watch rows now read as stalled when a run stays in `ci`, `fixing`, `review` or `merging` past that phase's limit, measured from the phase start. Phases that wait on a person or an agent never stall on time.
- 43ed110: `titan-factory shepherd register` exits 69 with one stderr line, and records nothing, when no `titan-factory serve` answers on `--port`. `--offline` keeps the old in-process registration. The read verbs still fall back to the database.
- 06193b5: Shepherd's wake, fixer, cleanup and reviewer ports now read the agent-chat roster through one shared reader in the serve process. Concurrent callers share one in-flight `agent-chat agent ls --json`, and a known roster is reused for 12 s. A spawn, resume, message or retire invalidates the reader. A failed read is reported as unknown and is never cached, so the next caller reads again.
- 5547952: Add `titan-factory shepherd stats`: per repo and ISO week, the PRs whose reviewer MERGE-to-merged wait exceeded 60 minutes with their total hours, and the merges made outside Shepherd. It reads the ledger read-only.
- a2af7fc: Map every Shepherd step family to its phase, so a run at a wake step lists as fixing and a late-verdict run counts as busy.
- 33bfc33: Shepherd's seat check lets a damaged seat-reviewer transcript block only the PR it reviews. A partial last record on an exited or detached reviewer now vetoes a MERGE only when the transcript's brief or a verdict block in its complete records names that PR; a transcript tied to no PR, or only to others, logs a warning and never vetoes. Each session under a seat reviewer's name is read on its own, so a damaged session no longer hides another session's FIX_FIRST.
- a8d3e1d: Shepherd's seat check reads each seat reviewer's transcript once per roster change instead of once per verdict. A cached read is reused while the reviewer's agent id, session id, presence and the transcript's size and mtime are unchanged; a new session under a name, a presence change, or an appended verdict reads again. A damaged transcript's veto is cached as the same rejection.
- 8716392: Shepherd now spends one repair budget per run on every fixer wake (ci-red, conflict, FIX_FIRST review, fix-proof), counted across heads and persisted as a step. A wake past `MAX_REPAIRS` opens one owner gate naming the wake kind and, for ci-red, the failing checks.
- 4b16b77: Shepherd's conflict wake treats only script-rewritten files as generated (CAPABILITIES.md, site/guides/capabilities.md, site/reference/index.md, the reference sidebar) and names `pnpm capabilities` and `pnpm docs:reference` to regenerate them. Hand-edited reference pages and .codewatch/check.json are hand-merged, never resolved by taking the base's side.
- Updated dependencies [32adb30]
- Updated dependencies [b62813c]
- Updated dependencies [775af4a]
- Updated dependencies [117c3ae]
- Updated dependencies [3a4d4ed]
- Updated dependencies [620a34f]
- Updated dependencies [f390fc0]
- Updated dependencies [26a39c5]
  - @titan-design/authority@0.3.0
  - @titan-design/daemon@0.3.3
  - @titan-design/hitl@0.5.0
  - @titan-design/store-sqlite@0.3.2
  - @titan-design/github@0.4.0
  - @titan-design/workflow@0.8.1

## 0.5.2

### Patch Changes

- 971f9e9: Shepherd checks GitHub's mergeable state against the current base before it opens approve-merge, and again once the owner
  approves. A head that conflicts goes back to the implementer as a conflict wake. Before, an approval could land on a head
  whose base had moved into a conflict, and the run then failed at update-branch.
- 971f9e9: Shepherd: a new head pushed while an `sh-sent-back` gate is pending now resumes the run. The head sweep cancels the gate
  as superseded, and the run awaits the new head and reviews it, with no owner answer. Before, the gate waited on the owner
  even after an implementer's successor had pushed the fix.

## 0.5.1

### Patch Changes

- 681d73e: Shepherd no longer merges or opens approve-merge at a head a seat reviewer sent back. When its own reviewer says MERGE, the verdict steps read every roster agent named like a seat reviewer (`-review` or `-review-r<n>`) through the review wiring's reader. If any such reviewer's newest verdict block naming this PR at this head is FIX_FIRST, the step records that FIX_FIRST instead, and the run wakes the fixer. A later MERGE from the same reviewer at the same head clears it, and a FIX_FIRST naming an older head does not block a new one.

  The transcript reviewer reader now also returns the `text` input of an assistant `chat_send` tool call, which is where seat reviewers send their verdict. A sent message never counts as the turn's final text, so a transcript that ends on the call still reads as unfinished. The seat check matches the verdict's repo without regard to letter case.

  The seat check fails closed. If the roster cannot be read, or a seat reviewer's transcript cannot be read or parsed, the verdict step records `none` with a reason that names the failure, and Shepherd does not merge at that head. A seat reviewer with no finished transcript yet reads as no verdict and does not block.

  The seat check reads a seat reviewer's transcript through the reader's new `readSeat`. A `chat_send` in any complete record counts as sent, whether or not the turn finished, so a reviewer whose process died after sending its FIX_FIRST still blocks. A partial last record rejects, and so blocks the head, once the reviewer has exited or detached; while it runs, the partial record is skipped. A `none` verdict now carries its reason, and the failed-rounds escalation names that reason instead of "the wait ran out".

## 0.5.0

### Minor Changes

- e883b16: Add `titan-factory digest run`: one markdown owner digest per slot (Needs you, Merged, Stuck, Seats, Spend) from Shepherd, pending gates, seat morning queues, seat dispatch logs and `agent-chat digest --json`, written to a digest dir and an optional iCloud dir. A failed source becomes a gap line. A Shepherd run that stops unmerged now records an `sh-stopped` step, and `WatchRow` gains an `outcome` field, so the digest lists such a run under Stuck with its reason instead of under Merged.
- 7c74898: `/health` now reports `busy: [{ runId, step, phase }]`: running runs whose current step is in review or merging, or routed `onRestart: "park"` (phase `park`). `service restart` polls it until `busy` is empty or `--drain-timeout` (default `45m`) passes, printing the busy runs each minute, then kickstarts. A park-routed step still busy at the deadline refuses the restart unless `--force`; `--no-drain` skips the wait. `ServicePorts` gains `now`, and `factoryHealth` takes an optional `routeFor`.
- c41ede8: Shepherd redeploys the factory after a green main CI on its own repo: step `sh-redeploy:<merge sha>` spawns `titan-factory service deploy --expect <merge sha>` detached, logging to the state dir, and returns at once. Other repos and a red or unread main skip it; a replay after the restart it caused spawns nothing.
- b36bc6a: Shepherd's second `FIX_FIRST` on a pull request starts a structural pass instead of another patch round. A new `sh-wake-fix-first` step counts `FIX_FIRST` wakes across every head of the run. Every review after the first asks the reviewer for a `Defect class:` section naming the recurring defect class and the one boundary where a single fix covers it. From the second `FIX_FIRST` on, the fixer's brief carries that section and the whole findings verbatim, so no blocking item is dropped.
- a5498fe: Shepherd lands one pull request per repo at a time through a merge train. A run boards the train at its merge step, updates its branch and waits for green CI while it holds the train, merges, and gives the train up when its land round ends. `shepherd status` names the run a waiting run sits behind. The holder lives in the new `shepherd_train` table (migration 10), so a restart keeps it. A holder whose run failed, was cancelled, is paused on a gate, or whose merge is held loses the train to the next run.
- db23ac6: New `titan-factory service deploy [--expect <sha>]`: under a pid lock, and only on a clean `main` checkout, it fetches origin, diffs the running build sha to the target against the factory workspace closure plus root build inputs, and either fast-forwards and records `skipped`, or snapshots the closure's `dist`, fast-forwards, runs `pnpm install --frozen-lockfile` under the worktree `setupEnv` pin, builds the closure, restarts drained and confirms `build.sha`. A failed install or build restores the snapshot and leaves the old process running; a failed restart or health check restores it and kickstarts. Both record `rolled-back`. It never runs `git reset`. `/health` gains `lastDeploy` from `deploy.json`. A lockfile change to a native-build package (`better-sqlite3`) is refused with the package named, the post-restart sha read polls `/health` instead of probing once, refusals are printed but never recorded, and the stale-lock takeover is atomic.
- 8390a74: Shepherd gains the `sh-carry:<head>` step, a tree-carry probe: `carry({ repo, baseRef, fromHead, head })` answers `{ equal: true }` only when `head` is a two-parent merge, `fromHead` is its ancestor, the second parent is on `baseRef`, and `git merge-tree --write-tree` of the second parent and `fromHead` is clean and equals `head`'s tree. It runs in a factory-owned bare cache at `<stateDir>/git-cache/<owner>/<name>.git`, which `serve` binds to its state dir. Any fetch or git failure answers `equal: false` with a reason. Nothing calls the step yet.
- b3e5cb1: Shepherd releases a `--reviewer` hold when that reviewer's newest verdict at the merge sha is MERGE. The hold check reads the named reviewer's latest session, refuses one in the implementer's lineage, and records the satisfaction with a compare-and-swap (migration 11). A new hold or a release clears it, `shepherd status` and `timeline` show it, and `sh-cleanup` releases the hold once the PR has landed.

### Patch Changes

- 311cece: `/health` now reports `build: { sha, behindMain }`: the git sha baked in at build time and how many commits main is ahead of it, from a cached `gh compare`. `service status` prints both.
- bf37034: Land treats GitHub's "Base branch was modified" HTTP 405 on a merge as `skipped: "base-moved"` instead of a failed step, so the loop re-reads the PR, updates the branch and merges the new head. Every other merge error still fails the step, and the existing update cap still ends the loop.
- e54f34e: A seat file's `read_only` must be a boolean; any other value is now a loud seat-book error instead of silently counting the repo as owned. The `leaveTrain` comment now says review and send-back wakes run inside land.
- 8247479: Shepherd waits out a reviewer spawn or resume that agent-chat's machine guard refuses (headless-agent total or memory floor). It asks again after 1, 2, 4 and then every 8 minutes for up to 30 minutes, and the watch row's next action names the wait. Only a refusal that outlasts the 30 minutes, or any other refusal, still sends the PR to the owner gate.
- 9d36afb: `shepherd register` writes its registration in the start hook, so a crash between starting the run and registering it leaves neither, and a concurrent register of the same repo#pr from another process returns the first run instead of starting a second. A repeat register can no longer widen a stored registration's merge mode or fixer.
- 75261b9: Shepherd seat lookup ignores repo entries marked `read_only: true`, so a read-only listing in one seat no longer narrows the owning seat's grants or flips a run to owner-gate.
- 9b219eb: Shepherd supersedes a seat-policy approve-merge gate whose pull request head moved. The serve sweep that ends merged-elsewhere runs now also checks each pending shepherd-pr approve-merge gate, at any iteration, and acts on it only when the run's last recorded merge decision gated that same head under the `shepherd-seat` table. When the open PR's head differs from that head, the sweep cancels the gate. The run records the cancel, leaves the land round and reviews the new head, so the owner is asked again only about a reviewed head. Conflict gates and escalation gates share the approve-merge step id but stay with the owner when the head moves, as do `sh-sent-back` and every other gate. Any cancel of approve-merge other than the sweep's still fails the run.
- 9636ab3: The release preflight retries a registry.npmjs.org read that fails with a 5xx or a network error, waiting 2, 4 and 8 seconds. If every attempt fails, the step fails and stores no blocked result, so the next sweep restarts the run and reads the registry again. A head blocked only by packages that npm answered 404 for still gates on the owner. Each sweep now re-reads npm for those packages, and once a hand publish lands it cancels that gate so a fresh run reads the release again.
- fd9536c: Shepherd: a sh-review repeat in resume mode asks for the resume again unless the roster shows the reviewer resumed after the intent (no longer exited, or its transcript written since), so a crash during the machine-guard wait no longer ends in a verdict-wait timeout. The agent-chat roster port now reports each transcript's last write time.
- 29bf752: Shepherd no longer counts a reviewer that a busy broker never started (machine guard or any `retryable: true` refusal) as a failed review round, so it retries at the same head instead of opening approve-merge.
- 724330a: A held merge stops waiting once its PR is merged or closed outside Shepherd, so land takes its merged-elsewhere path without a merge call. `shepherd status` now reads a run as stalled after three review dispatches in a row that a busy broker never started.
- Updated dependencies [0c697f8]
- Updated dependencies [e54f34e]
- Updated dependencies [e54f34e]
- Updated dependencies [ce4fe2f]
- Updated dependencies [e651365]
- Updated dependencies [9b219eb]
- Updated dependencies [9d36afb]
- Updated dependencies [ad65b8c]
- Updated dependencies [5605896]
- Updated dependencies [9c04876]
  - @titan-design/worktree@0.1.2
  - @titan-design/authority@0.2.2
  - @titan-design/github@0.3.2
  - @titan-design/workflow@0.8.0

## 0.4.1

### Patch Changes

- 3eca440: Shepherd treats an `update-branch` HTTP 422 "merge conflict between base and head" as a conflict instead of failing the run: it wakes the fixer, and opens `approve-merge` only if the conflict survives one wake. A run that reads a new head cancels its own pending `approve-merge` and `sh-sent-back` gates for an older head. `WorkflowContext` gains `expireGates(reason, isStale)`, and the fake GitHub gains `updateBranchConflict`.
- Updated dependencies [3eca440]
  - @titan-design/workflow@0.7.0
  - @titan-design/github@0.3.1

## 0.4.0

### Minor Changes

- bc230e7: Shepherd acts on a red main after its own merge. `sh-freeze` freezes the repo. `sh-file-fix-task` files one active-work task per episode over loopback rpc. The task is tagged with the (repo, merge sha) key and carries the fenced log tail. `sh-spawn-fixer` spawns one fixer per episode under a deterministic peer name, if the policy grants a fixer. A red while the episode has a fixer, the fixer's own merge included, opens `main-red-again` for the owner. A green merge that descends from the red sha unfreezes. The freeze exemption now also requires the PR's implementer to be the episode's fixer. Unfreezing requires every check that was red at the red sha to run green again. A failed bind no longer leaves an earlier store bound. New config key: `shepherd.fixer.configDir`.
- a24d9be: A Shepherd reviewer that exits, deregisters or stays detached without a verdict ends `sh-await-verdict` after a grace (`exitGraceMs`, default 1 min; `detachGraceMs`, default 10 min, so a broker restart does not count) instead of waiting out the 30-minute timeout. The wait returns `none`, and the route table decides what follows.
- 86bb7a2: Shepherd routes every reviewed green head through one table keyed by run state, GitHub's `mergeable_state` and the review outcome. A PR that went behind during a MERGE review updates its branch instead of gating. A silent or timed-out reviewer gets a fresh reviewer at the same head. A head that moved starts a new round, and a PR merged or closed elsewhere ends the run. A run held for a named reviewer spawns no reviewer and takes that reviewer's verdict. `approve-merge` opens only for a conflict that survived one fixer attempt, 3 failed review rounds, or a policy that did not allow the merge, and its prompt names which. `titan-factory serve` cancels a gated run once its PR merges or closes elsewhere. `sh-wake-implementer` messages a live implementer, requires a new turn within 5 minutes, and sends one fallback resume or message. `gate resolve` exits 0 when it repeats the answer a run already took.
- 1873696: Shepherd lands the changesets Version Packages PR with no human step. `titan-factory serve` registers an open PR from `changeset-release/main` in each watched repo, and pushes one empty commit to start CI on a head the changesets action left without runs. A release preflight replaces the reviewer: every changed file must be one `pnpm version-packages` writes, each changed manifest may change only its `version` and the dependency ranges of packages the release bumps, and every public package must already exist on registry.npmjs.org, else the gate names the package. While the release is ready under an `auto` seat, the repo's other Shepherd merges wait for it, and a merge that waited reads CI again before it merges.

  The failed-rounds counter counts only stuck rounds (silence, timeout, conflict). A FIX_FIRST that yields a new head is progress, and a sixth FIX_FIRST gates as `fix-first-runaway`. A hold's reviewer comes only from `shepherd hold --reviewer`, never from the hold's reason text. A live hold that named its reviewer only in the reason text no longer waits on that reviewer; re-issue it with `--reviewer`. A reviewer that misses the verdict wait is read again for up to 10 minutes, so a MERGE written late counts. A post-merge main run cancelled because a newer main push superseded it is followed to that push instead of opening `main-red`.

### Patch Changes

- fe11f1b: Evidence reads the trace gates key from `@titan-design/workflow` (`TRACE_GATES_KEY`) instead of its own literal.
- e96997d: Nit batch: Shepherd hold and verdict regression tests; session-analytics maps the `decider` profile to planner, orders wake pairs tied on cost by sender kind, picks the newest reviewer cohort by instant and reports its size as `requestsFromSessions`; session-miner insights read a zoneless timestamp as UTC.
- 9d86311: A Shepherd hold registered with a `refs/heads/<branch>` name now holds a PR whose head branch is the bare `<branch>`, and the reverse.
- Updated dependencies [86bb7a2]
- Updated dependencies [fe11f1b]
- Updated dependencies [1873696]
  - @titan-design/agent-dispatch@0.3.0
  - @titan-design/workflow@0.6.1
  - @titan-design/github@0.3.0
  - @titan-design/session-read@0.8.1

## 0.3.0

### Minor Changes

- e1012bd: The factory host runs `gateResolverMigration(7)`, so every resolved gate records who resolved it. `titan-factory gate resolve` passes the owner at a terminal (`owner-terminal`, the OS user, channel `factory-cli`), or `coordinator` when `AGENT_CHAT_AGENT_ID` is set, which hitl refuses: the command exits 1 and the gate stays pending. `SHEPHERD_MIGRATIONS` names the shepherd tenant's versions 4 to 6.
- bbef5f5: `service install --mcp` accepts `--claude-config-dir <dir>` (repeatable) and registers the MCP endpoint in each dir, printing the config file written. A path that is not a directory fails before anything is written.
- 1b927d6: Add `transcriptReviewerReader`, the production `ReviewerReader` for Shepherd. It finds the dispatched reviewer on the roster by agent id and reads its transcript only once the agent has exited in the dispatched session. It returns one message per assistant text part, in file order, with the session-read locator of that part. It returns nothing unless the whole file was read and the conversation ends with assistant text, so a reviewer must end its turn with the verdict as text. User messages and copied history are excluded, and a message with no usable timestamp is kept.
- 6f9ab40: Shepherd's review phase is wired from the config file. `shepherd.agentChatBin` names the `agent-chat` executable and must be an absolute path. `shepherd.review` takes `profile` and the optional `configDir`, `verdictTimeoutMs` and `sessionStartTimeoutMs`. With `review` set, `configuredRoutes` builds one `agentChatReviewerDispatch` and gives its roster to `transcriptReviewerReader`, and the reviewer starts in the checkout that the seat book binds to the PR's repo. With no `review` key no `agent-chat` process is started and `sh-review` answers `none`, as before. The load refuses `review` without `agentChatBin`, an unknown key under `review`, and a `profile` or `configDir` that is empty, starts with a dash, or holds whitespace, because each reaches the `agent-chat` argv as one argument. `shepherdRoutes` takes a second argument, `{ review? }`, and passes it to `reviewRoutes`. `FactoryRouteDeps` gains `review` and `isFrozen`.
- 031fa30: `shepherd register --slice <label>` marks a PR as one slice of a multi-slice task. When it lands, cleanup appends "<label> landed in <repo>#<n> at <merge sha>" to the task's notes and leaves the task open. Without `--slice` the task is closed as before.

### Patch Changes

- 16f30c3: `sh-cleanup` gives the ref delete, the task close and the retire each their own hour of retries, so a GitHub outage no longer starves the other two. Fresh reviewer names now carry the repo owner (`rv-<owner>-<repo>-<pr>`), so same-named repos of two owners no longer share one.
- 6edb156: Import `routedRunner` from `@titan-design/workflow` and delete the local adapter. Factory still re-exports the routing types. Registration now also refuses two routes that match the same step id.
- d2e08f7: The post-merge chore settles on its process exit plus a short pipe grace instead of waiting for every holder of its output to close, so a chore that leaves a daemon behind records its real exit code without timing out. The timeout's group kill no longer targets a pid after its exit was observed.
- d9f27c2: The LaunchAgent plist now sets `EnvironmentVariables` with one variable, `PATH`: the directories of `gh`, `agent-chat` and `claude` as found at install time, node's directory, then launchd's four. Under launchd's default `PATH` serve could not run `gh`. A directory with a `:` in its name is refused, `--node` included. A binary that is not found gets a warning line, and `service install` refuses to run without `gh`. `service install`, `restart` and `status` exit non-zero when `/health` answers but its `github` field is not `ok`, and no longer accept a `/health` with no pid for a job launchd reports no pid for.
- d66989e: Land and Shepherd's merge-facts collection fail closed when a repo's required checks cannot be read. A port error, a 403 (rulesets dropped on a private repo on GitHub Free) or a 404 stops land and gates the merge with a reason naming the repo and the HTTP status, instead of being read as "no required checks". A successful empty read behaves as before.
- 679866f: Land treats a `blocked` pull request as green once its required checks pass and the only block is an approval rule the caller can bypass, so Shepherd runs leave the ci phase instead of polling to timeout.
- f7bf980: Shepherd's merge evidence treats a `blocked` PR as merge-tree-clean when the only block is a review rule the merge path bypasses, read through the same `reviewRulesBypassable` as the land ci-wait. An unreadable ruleset or a conflicting PR still gates.
- 7e4103a: Shepherd keeps a per-repo freeze in the factory database (`shepherd_freeze`, migration 6) and the merge guard refuses every PR of a frozen repo except the one registered to the freeze's fix task. A blocked merge re-reads the default branch at most every five minutes and lifts the freeze when its head, other than the red sha, has all-green Actions runs. The merge evidence step now reads `isFrozen` from that store by default.
- 7c6ed6b: `shepherd register` starts a new run when the registration's run has failed, re-points the registration to it, and returns `previousRunId`. Runs in any other status still come back unchanged.
- a079898: Refuse backslash, percent, `..` and over-long session ids in the evidence locator reference.
- 8bdc0ec: Shepherd's wake phase now wakes an implementer. A new `sh-wake-implementer` step builds a fenced payload: the last 150 lines of each failing job's log, 8 KB in total; a FIX_FIRST review's findings; or the files both the PR and the base changed, as conflict candidates. It then wakes the newest of the implementer and its `<implementer>-s<k>` successors. A live agent is waited on and never resumed. An ended agent whose transcript's last event is under 50 minutes old and whose fill is under 200k tokens is resumed. Otherwise a successor is spawned under the `implementer` profile in its predecessor's checkout, with a brief that names the predecessor and the PR's head branch; a predecessor whose tree was parked returns `unhandled`. A broker that is down or a timed-out call keeps the step waiting. A broker refusal, a seat with no fixer, or no configured `shepherd.agentChatBin` returns `unhandled`, so the owner gate decides. `wakePhase` then runs `sh-await-new-head` and returns `woken` only once the PR shows another head. `configuredRoutes` now passes the configured `shepherd.agentChatBin` to the shepherd routes.
- 8d52f2d: Shepherd's review phase now dispatches a reviewer. A new `sh-review` step stamps `{head, reviewer, at}`, then spawns a fresh `rv-<repo>-<pr>` reviewer through a `ReviewerDispatch` port, or resumes the registration's opt-in reviewer when it has exited under 300k fill and the roster proves it independent of the implementer: no author of the code is the reviewer, spawned it, or handed over to it, at any depth. A roster row without a `predecessor` field proves nothing, so a port that stores no lineage always gets a fresh reviewer. The brief carries only the repo, PR and head. `reviewPhase` runs `sh-review`, then `sh-await-verdict`, and takes an accepted MERGE through `sh-merge-evidence`. With no dispatch wired the step answers `none` and the owner gate decides. A FIX_FIRST keeps at most 16,000 characters of the reviewer's message in the step output, cut at the end with a `[truncated]` marker.
- a272937: `shepherd-pr` runs `sh-cleanup` after the main CI read. It deletes the merged head ref through the PR's head repo, so a fork head or the default branch is skipped. It marks the registration's task done only while active-work reports it open. It retires successors, the implementer and fresh reviewers, never the standing reviewer, no sooner than 3 minutes after exit and never with `--force`. Refusals past an hour end as caveats, not a failed run.
- 06ffd8c: `Commit` gains an optional `committedAt`, the committer date, which the `gh api` wire reads from `git/commits`. The factory's `land` now refreshes a behind PR in a repo without strict required checks when its base moved after the head's last green run: before a green verdict goes on to approve-merge, `ci-wait` compares the base tip's committer date with the earliest start of the head's latest required GitHub Actions runs. A base tip committed later, or one with no readable date or run start, is treated as moved, so the verdict is `behind` and the existing update-branch path runs under the same update cap before CI is awaited at the new head. A strict repo keeps its behaviour.
- ec41105: Shepherd's seat book refuses a remote bound to two different checkout paths, naming both seat files and paths, instead of letting the later file win.
- dc7be96: shepherd-pr parks the registered implementer's worktree in a new `sh-park:<head>` step once CI is green at a head, before that head's review. A refusal or an unreachable broker is recorded in the step output as `not-parked` and the run continues. `FactoryRouteDeps.park` and `ShepherdWiring.park` replace the default `agent-chat agent park` call.
- a979298: Shepherd's `sh-wake-implementer` step now handles an implementer whose tree was parked. A warm implementer is resumed even when its checkout is gone, because resuming re-creates the tree at its old path. A successor no longer starts in its predecessor's tree path: it starts in the repo's main checkout, taken from the seat that binds the repo, and its brief tells it to fetch and check out the PR's head branch at the PR head before editing. A repo that no seat binds returns `unhandled`. Each successor is recorded in the run's lineage. A conflict where every conflicting file is a generated registry (`CAPABILITIES.md`, `site/reference/**`, `site/.vitepress/reference-sidebar.json`, `site/guides/capabilities.md`, `.codewatch/check.json`) gets a generated-only brief: merge the base, take its side of those files, run `pnpm build` then `pnpm capabilities`, commit and push. A mixed conflict keeps the hand-merge brief and marks which files are registries. The base branch is now checked as a ref name and fenced as data. A refused re-ask whose earlier, timed-out ask has since landed counts as woken.

  The successor's checkout path goes through the same checks as the reviewer's: a `~/`, `$HOME/` or `${HOME}/` prefix expands against the home directory, and a path that is not absolute or not a directory returns `unhandled` with the reason. Both now share `resolveCheckout`.

- 3350015: The capability row and the factory docs now say the factory requests dispatch through agent-chat, via `@titan-design/agent-dispatch`, for the Shepherd reviewer. The factory guide's config example shows `shepherd.agentChatBin` and the `shepherd.review` block.
- c1b9f81: Shepherd gains its production reviewer port. `agentChatReviewerDispatch({ agentChatBin, profile, cwdFor, configDir? })` implements `ReviewerDispatch` over `@titan-design/agent-dispatch`, which the factory now depends on. `ReviewerDispatch.spawn` takes the `ReviewTarget` as a third argument, so an existing implementation of the port must accept it. A spawn starts the reviewer under the one configured profile, in `cwdFor(target.repo)` with a leading `~/`, `$HOME/` or `${HOME}/` expanded, and sends the brief on stdin. A repo with no checkout path, or a path that is relative, missing or not a directory, is refused before `agent-chat` runs. Only an unreachable broker becomes `ReviewerBrokerDown`, which the step waits out; every other failure, a timeout included, is a refusal. Roster rows carry `transcriptPath` and `transcriptExists` for the verdict reader and leave `predecessor` and `fillTokens` absent, so no standing reviewer is resumed yet.
- dc85fc8: Shepherd records which reviewer a head gets before it starts one. The review phase now runs `sh-review-intent:<head>` and then `sh-review:<head>`. `sh-review-intent` has no side effect: it reads the roster, chooses the reviewer, stamps `at`, and answers `{ kind: "intent", head, reviewer, at, mode, agentId? }`, or `none` when no dispatch is wired or the roster read is refused. `sh-review` takes that intent as its input and reads the roster first. In spawn mode it spawns only when no agent holds the intent's name, adopts the one agent that holds it, and answers `none` when two hold it. In resume mode it resumes on its first run only; a repeat after a crash adopts the agent by its id. A replay therefore reuses the same name and the same `at`, so a crash between the spawn and the stored step output no longer starts a second reviewer, and the reviewer's first words still count as written after the dispatch. `REVIEW_STEPS` declares the new step, and the `sh-review` input changes from `{ runId, repo, pr, head }` to `{ repo, pr, head, intent }`.
- 0220323: Shepherd's store now records who wrote a run's code. A new `shepherd_lineage` table, added by its own migration (version 5, after the registration table's version 4), holds one row per run and agent: name, role (`implementer` or `successor`), the predecessor a successor took over from, and when it was recorded. `ShepherdStore.recordAuthor(runId, agent)` is idempotent on run and agent id and keeps the first row on a repeat. `authorsOf(runId)` returns that run's authors in a stable order. Existing databases keep every registration when they gain the table. Nothing calls it yet.
- 61ecad3: Shepherd's PR evidence comment no longer posts the reviewer transcript's hostname or absolute path. It carries the session id, record offset, part position and a hash of the full locator; the stored record keeps the whole locator.
- f518eb1: Shepherd's merge evidence comment posts a session id only when it is a plain string and record offsets only when they are integers, and the locator hash recipe is documented.
- eb1ffb1: The Shepherd view reads a run paused at `sh-review-intent` or `sh-merge-evidence` as phase `review` instead of `ci`.
- 797bcdd: TP-637: Shepherd's seat book accepts repo and deny_repos paths whose segments contain inner spaces, such as `~/Library/Application Support/x`. Leading or trailing spaces, glob characters, quotes, backslashes and dot segments stay refused.
- 46b2880: `ctx.authorize(stepId, request, options?)` asks the authority table before a governed action, in one durable step. `allow` returns `{ verdict: "allow", ruleId }`. `deny` records the decision and throws `AuthorityDeniedError` without opening a gate. `gate` opens a hitl gate bound to the rule (`rule: { table: "F5", version, ruleId, resolvers }`) whose answer must be `{ decision: "approve" | "refuse", subject }` echoing the request's subject; an owner approval returns `{ verdict: "approved", ruleId, gateId, resolvedBy }`. A refusal, a resolver outside the recorded rule, or a gate resolved with no resolver throws `AuthorityRefusedError`. A restarted run resumes onto the same gate and judges the answer by the rule recorded on it, so a table edit during the pause does not flip the decision. Replay returns or throws the recorded outcome without consulting the table. The runtime takes `authority: { table?, actor }`; the table defaults to `DEFAULT_TABLE`. `StepOperation` gains `"authorize"`. The factory's step guard (`guardedContext`, `StepKind`) passes `authorize` through its declaration check.
- Updated dependencies [6e848b7]
- Updated dependencies [101119f]
- Updated dependencies [679866f]
- Updated dependencies [83e6c69]
- Updated dependencies [ccbdde0]
- Updated dependencies [9bef02d]
- Updated dependencies [9ac05b5]
- Updated dependencies [9c0aa55]
- Updated dependencies [8b0e7ed]
- Updated dependencies [50a7550]
- Updated dependencies [1712421]
- Updated dependencies [88bf9f7]
- Updated dependencies [c583709]
- Updated dependencies [06ffd8c]
- Updated dependencies [dc7be96]
- Updated dependencies [f3f843d]
- Updated dependencies [9f49074]
- Updated dependencies [46b2880]
- Updated dependencies [9c0aa55]
  - @titan-design/authority@0.2.1
  - @titan-design/workflow@0.6.0
  - @titan-design/github@0.2.0
  - @titan-design/hitl@0.4.0
  - @titan-design/registry@0.3.2
  - @titan-design/session-read@0.8.0
  - @titan-design/agent-dispatch@0.2.0
  - @titan-design/daemon@0.3.2

## 0.2.0

### Minor Changes

- bb2565b: Register the `land-pr` workflow: a snapshot of the PR, `land` rounds, one code-owned rerun when every failing check was cancelled or timed out, and otherwise a `ci-failed` gate (`rerun`, `abandon` or `await-fix`, bound to the red head). Add `awaitNewHead` and `awaitNewHeadRoute`, which block until a PR shows a head other than the red one.
- 4c9ee27: Add the land-pr `post-merge` step: after a merge it runs the configured `postMerge.argv` with no shell, passing `LAND_PR_REPO`, `LAND_PR_NUMBER` and `LAND_PR_MERGE_SHA` in the environment. It records the exit, signal, `timedOut` and redacted output tails, or `skipped` when no command is configured. On timeout the chore's process group is killed with SIGKILL. The step is routed `park`, so a crash mid-chore holds the run for a human instead of repeating the chore. A malformed `postMerge` config key, a relative `cwd` or a NUL byte fails the config load.
- 916226c: Add the factory registry (`factory.land`, idempotent on repo#pr; `factory.status`; `factory.gates`, with no resolve command) served as `factory__land`, `factory__status` and `factory__gates`. Add `titan-factory serve [--port]`, and `titan-factory land <owner/repo#N> [--task slug/id]`, which hands the PR to a running server over loopback and otherwise drives it in-process to completion or a gate.
- b9d0dab: Add a long-lived serve mode. `FactoryHost.adopt()` claims unfinished runs and keeps driving them. `startFactoryServer` and `serveFactoryUntilSignal` host the factory database under `@titan-design/daemon` on port 7410 with an empty tool prefix. The server adopts runs at start and sweeps every `leaseMs` for runs whose owner exited without releasing, and `/health` reports run counts by status and pending gates.
- 881098b: Add `titan-factory service install [--port <n>] [--node <path>] [--mcp]`, `uninstall`, `status` and `restart`. Install boots out a loaded job, writes the LaunchAgent plist, bootstraps it and waits for `/health` from launchd's own process, exiting 1 with the tail of `serve.err.log` when it never answers; `--mcp` registers the MCP endpoint with `claude` and never fails the install. `status` exits 0 only when `/health` answers. Each verb fails with one line off macOS; `service plist` is unchanged. The root script `pnpm factory:install` installs, builds factory with its workspace deps and links `~/.local/bin/titan-factory` to the built bin.
- bf44ca0: Add `titan-factory service plist`, which prints the `dev.hjewkes.titan-factory` LaunchAgent plist (`ProcessType` Interactive, `KeepAlive` and `RunAtLoad` true, logs under the XDG state directory). `titan-factory serve` health gains a `github` field: `ok`, or the redacted error from `gh api rate_limit`, probed in the background at most once a minute with a 10 s timeout.
- 3ac10ee: Add the `shepherd.register`, `status`, `list`, `timeline`, `hold`, `release` and `merge` registry commands, served by `titan-factory serve` as MCP tools `shepherd__<cmd>` and `/rpc/shepherd.<cmd>`, and as `titan-factory shepherd <cmd>`. `register` refuses a denied repo before starting anything and is idempotent on `repo#pr` and on the PR's head branch. `merge` evaluates the policy and resolves no gate; gate resolution stays CLI-only. `list` and `timeline` return the `WatchRow` and `PrTimeline` shapes exported from `shepherd/view.ts`.
- 90200c7: `land()` takes a `round`: every dispatch step id after round 0 carries `r<round>`, so a pilot that re-enters `land()` after a rerun or a new head gets fresh step ids. Round 0 keeps its existing ids. Before any merge of an untrusted head, `land()` calls `GatePolicy.decide("merge", { headSha })` and records the decision in a `merge-policy` code step with the policy trace gate. It branches on the recorded decision, so a replay reuses it instead of asking the policy again. On `allow` the step also stores the caller's `allowEvidence`, and `land()` trusts that one head without opening `approve-merge`. hitl refuses automation resolvers, so an automated merge can never resolve that gate. An allow never extends to a head this run's update-branch built, and it does not reset the update count behind `stuck-behind`. `GatePolicy.decide` takes an optional `GateTarget`.
- 3520eb9: Add the Shepherd step `sh-await-verdict`: it waits for the Verdict block in the final message of the dispatched reviewer's agent and session, written after dispatch and naming this PR at the exact head, and records the session-read locator. The deadline ends the wait with `none`.
- 1629204: Add the `shepherd-pr` workflow. It waits in `sh-await-pr` for a registered branch's PR, then lands the PR round by round under `shepherdGatePolicy`. A red head, a dirty PR, or a `FIX_FIRST` or `NO_REPRO` review wakes an agent first; an unhandled wake falls back to land-pr's `ci-failed` gate or the owner's merge gate. The review runs at every green head before the merge decision. Registrations live in a `shepherd_registration` table (migration 4) in the factory database, and every merge goes through a hold, so a held PR never reaches the port's merge. `ShepherdPhases` requests now carry `repo`, `pr` and `round`, wake gains the `fix-proof` kind, and `Verdict` gains `NO_REPRO`. Route sets can carry a `DatabaseTenant`, whose migrations and binding the host applies.
- 7cde3db: Add Shepherd seat policy: `shepherd/seats.ts` reads autonomy-seat/v1 seat files and the charter's hard stops, and `shepherd/policy.ts` resolves the effective per-PR policy as the seat default narrowed by the registration, refusing denied repos. `shepherdGatePolicy` maps it to a `GatePolicy`. Config gains `shepherd.seatsDir`, `shepherd.charterPath` and `shepherd.hardStopRepos`. Every input fails closed: an invalid seat file or configured charter throws `SeatBookInvalid`, a repo key that is not a bare `owner/name` is denied, and a request that does not match `RequestedPolicySchema` throws `RegistrationRefused`. Seat files canonicalise every repo reference at parse: remotes must be a bare `owner/name` and are lowercased. Paths get one comparison key (lowercased, slashes collapsed, trailing slash dropped, `$HOME`, `${HOME}` and the home directory spelled `~`), and a path is accepted only as `~/`, `$HOME/`, `${HOME}/` or `/` followed by plain `[A-Za-z0-9._-]` segments (never `.` or `..`); every other spelling throws. An injected home must be absolute and not `/`. Symlinks are not resolved. One path-to-remote index across all seats resolves every `deny_repos` path, and a path bound to two remotes throws. A deny path no seat binds denies its basename under any owner, and throws unless that basename is a valid repo name. `hardStopRepos` requires `charterPath`, and the charter must be `autonomy-charter/v1` with a `hard_stops` list. A repo several seats list gets the grants they all share. `Seat.paths` maps each lowercased remote to the seat's local checkout path, the cwd for Shepherd spawns.

### Patch Changes

- 9b1aff3: Make the `ci-wait` and `update-branch` step deadlines survive a clock jump: a sleep that overruns by more than a minute defers expiry to one fresh poll at least two minutes after the wake.
- 9b01c07: `land` judges checks over every run at the head with `mergeReadiness` semantics: a red run of a required context blocks even beside a newer green one, a required context needs a run concluding `success` (neutral and skipped no longer pass), and only GitHub Actions runs count, so any red Actions run at the head is `ci-failed`. `@titan-design/github` exports `headCheckFindings`, the check evaluation `mergeReadiness` now delegates to, with `CheckFinding` and `HeadChecksInput`.
- 7214ca9: A malformed factory config file no longer kills commands that never need it. `factoryRoutes` is now a function that builds the routes on first call instead of at module import, so `titan-factory --help` and `service plist` succeed. `loadConfig` reports invalid JSON with the config path.
- 5204caf: Wire the configured `postMerge` command into the production route set: `factoryRoutes` now reads it from the config file, so the land-pr post-merge chore runs instead of always recording `skipped`. A new `configuredRoutes(env, overrides)` builds that route set.
- ced913f: Add `@titan-design/github`: the factory's GitHub REST port (`githubPort`, `ghCliWire`, `evaluateChecks`, `latestPerName`, argument validation and the `fakeGitHub` test wire), moved unchanged with its tests. The factory now depends on it and deletes `src/github/`; its root no longer re-exports the GitHub types and functions, so import them from `@titan-design/github`.
- 5d46953: Add the Shepherd phases contract (`ShepherdPhases`, `WakeRequest`, `WakeOutcome`, `Verdict`) with wake and review stubs. The stubs declare no steps, wake reports `unhandled`, and review returns `none`, so the owner gate keeps deciding until the real phases land (TP-484).
- a2dcdf8: Shepherd's `merge:auto` seat now allows a merge only when authority's `MRG-AU-RV` holds on merge facts collected at the exact head. A new `sh-merge-evidence` step collects the facts and posts one evidence comment per head. Any `.github/` path, including a rename source, still gates. `shepherdLandOptions` hands the evidence record to `allowEvidence`.
- 1f2f01f: Shepherd reads main CI on the merge sha after land returns merged, records green, red or none, and opens the owner gate main-red on red or none. A non-empty `after` stage list runs nothing and opens the owner gate after-stages.
- 26e94c6: Harden Shepherd's merge authority: an unbound store refuses merges through `factoryRoutesFor`, a held branch registration holds its PR before the PR is recorded, the registration's policy can only narrow the run's, a FIX_FIRST or NO_REPRO whose wake is unhandled asks a human instead of reaching the merge decision, and `sh-await-verdict` refuses a non-numeric `writtenAt` or a locator outside the dispatched session.
- b0335d0: `execGh` takes an optional third argument `{ timeoutMs }` that SIGKILLs the `gh` child and rejects when the time passes; callers that omit it behave as before. The factory `/health` probe passes 10 s, so a hung `gh` no longer lingers. `service plist` maps a Homebrew Cellar node path to the prefix symlink when it resolves to the same binary, and accepts an absolute `--node <path>`.
- 6f77fa1: Documentation only. The factory README names the two registered workflows, the `serve` and `land` verbs, the current package list and both gate policies, and links the new usage guides. The code-report README corrects the index time and links its usage guide.
- Updated dependencies [be51d27]
- Updated dependencies [17b952e]
- Updated dependencies [9b01c07]
- Updated dependencies [ced913f]
- Updated dependencies [84b230d]
- Updated dependencies [19e7b14]
- Updated dependencies [661244b]
- Updated dependencies [0bf3f20]
- Updated dependencies [b0335d0]
- Updated dependencies [e5108b7]
  - @titan-design/authority@0.2.0
  - @titan-design/daemon@0.3.1
  - @titan-design/github@0.1.0
  - @titan-design/session-read@0.7.0
  - @titan-design/hitl@0.3.1

## 0.1.0

### Minor Changes

- 27d1ea2: Add the factory product: host, routed step runner, `resume` and `gate resolve` verbs, and the F3 evidence and F5 gate-policy seams.
- 87d48cd: Add the factory GitHub port (a `gh api` adapter with check-then-act writes) and the land core: wait on the latest run of each required check, keep a behind branch current under `expected_head_sha`, and merge the gate-approved head under `sha`.

### Patch Changes

- bee71b0: Read typed step data in the land steps instead of casting parsed output.
- Updated dependencies [629cdd9]
- Updated dependencies [d0ce38a]
- Updated dependencies [c6bb111]
- Updated dependencies [f160116]
- Updated dependencies [3085355]
- Updated dependencies [46dfd6c]
- Updated dependencies [8e2d31f]
- Updated dependencies [d7f09e5]
  - @titan-design/hitl@0.3.0
  - @titan-design/workflow@0.5.0
