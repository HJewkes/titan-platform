# @titan-design/factory

## 0.26.0

### Minor Changes

- 38ef029: Add the `titan-factory autoresearch` command group (`start`, `resume`, `status`, `add-idea`, `milestone`) and the `autoresearch` config section. With the section set, the factory hosts the `autoresearch` and `autoresearch-validate` workflows, with ports built per target from the config. The new write commands are `autoresearch.start`, which refuses a target that has an unfinished run; `autoresearch.add-idea`, which writes to an fsynced owner inbox; and `autoresearch.milestone`, which caps looks at `maxLooks` and needs serve. The evaluator gains the `validate` port, which returns aggregates only over held-out cases, and the `registry` port. A failed `git fetch` at pin time is now retryable as `[pin-fetch]`.
- a3a802d: Add the real autoresearch evaluator ports. `evaluatorPorts` pins a run to an evaluator checkout and an integration checkout of the target clone, reads `target.json` and `bounds.json` at the pin, refuses a class glob that reaches a frozen file in the pin's file list, and points the ratchet ref at the pin. Every eval and micro run is guarded on both sides: the evaluator checkout must be clean and its frozen files must hash as they did at the pin. L0 runs the bounds post-check on the real diff, the unit suite and the test proof (skipped for excepted classes), each row timed, with the first failure as the code. The ratchet uses the pinned target's prefix, and the archive writes `round-<n>.tgz` with a `SHA256SUMS` line. `arProductionPorts` composes them with the agent ports. The autoresearch routes now record `startedAt` and `restarts`, pass dispatch usage to the runtime, and record the ratchet's move.
- ad0d9b3: The autoresearch evaluator gains the `integrate` port: it merges a later round winner onto the round's new head in the run's integration tree, in a detached checkout and never pushing. The merge commit is dated with the step's first start, so a restarted step rebuilds the same sha. A conflict is aborted, which leaves the tree clean, and the conflicting files are named. The ratchet port passes the move's `kind` through unchanged.
- af2b1e0: Make autoresearch steps safe across a host restart. The eval, L0, L1 and ratchet steps now name the run and its recorded pin (`RunPin`: `runId`, `pin`, `frozenHash`), and the implement step names `runId`. `ArStepHandler.run` takes the runtime's `StepTiming`, and the load-wait handler passes the step's `firstStartedAt` to `loadWait`. The `plan` port now answers `{ ops, agent?, sessionId?, mode?, usage? }` (`PlannedSchema`), and the round record gains an optional `planner`.

  In the factory, the evaluator ports rebuild a run's session from the step's recorded pin after a restart and refuse with `[frozen-drift]` when the frozen files no longer hash to the recorded value. The load gate counts its optional `maxWaitMs` deadline from the step's first start. The planner reports its agent, session and usage. A `[tree-live]` failure is retryable. Implementers are named from the run id rather than the tree name.

- ce64ef9: Add the autoresearch workflow skeleton (S1): a central planner's queue ops checked against quotas and the bounds pre-check, Thompson sampling over lineages with a seeded RNG, a pipelined per-idea ladder (L0 static, L1 micro, L2 one run, L3 repeats with confirm runs) fanned out with `mapItems`, the keep rule with a pooled within-pair σ band, dead-end and bug registries, a planner digest that never carries validator rows, and a fast-forward-only ratchet push. Ports are fakes in this slice; no CLI or production wiring yet.
- 581c26f: Add the reconciler's `BotActionUnlogged` detector (TP-3094 C7). The backstop snapshot now reads each review's author and commit, each status's creator, and every `shepherd-train/**` branch head. The reconciler matches the bot's reviews, statuses, merges and train pushes against factory intent rows (`merge_op` for merges, a new append-only `factory_bot_intent` table for the rest), raises `ops-alarm BotActionUnlogged <repo> <kind> <id>` once per action, and marks it not-factory so it never counts as a factory approval. `BotPorts` gains the bot's `login`.
- 9d28087: Add the autoresearch agent ports: idea-tree allocation and branch-keeping release, planner and implementer dispatch on the agents account with a limits check, resume of the winner's implementer on an exploit lane, a per-round spawn stagger, and the load wait.
- 384818e: A coordinator may answer an `sh-sent-back` gate with exactly `{"decision":"await-new-head"}` while the PR is open at the head the gate asks about (owner decision 529). `gate resolve` reads the PR fresh and stores it as `pr-at-head` evidence, which the gate store re-checks; a moved head, a closed or merged PR, or any other payload falls back to the owner's presence dialog. `approve-merge` and every other gate keep their existing rules.
- d1db279: The owner digest leads with a stale-gate line when the approve-merge median wait passes 24 h or any owner gate has waited over 72 h, listing those gates with console resolve links built from the new `digest.consoleOrigin` key (https only; loopback origins are refused). Without an alarm the digest is unchanged (TP-4545, TP-4368).
- 343721c: Serve's bot identity (TP-3094 C3): `openBotIdentity` reads the bot token through `trackSecretFile` from the code-fixed `BOT_TOKEN_PATH` (undefined until the owner ratifies a path), builds an `octokitClient` with its own `throttleId` and `RateBudget`, and hands it only to the workflow capability `github-bot`. An absent or refused file disables only the bot: serve starts, bot steps get `blocked` with no client, and `/health.bot` reports `{ state: "ok" | "absent" | "refused", problem? }`. The systemd unit gains `LimitCORE=0`.
- 0f86066: The bot client reads GitHub's `github-authentication-token-expiration` header on every response. `/health.bot` gains `expiresAt` (ISO time, null before the first response or for a token with no expiry), and with 14 days or less left serve logs one `factory: ops-alarm bot-token-expiry` line per token fingerprint. `ops/runbooks/bot-token-rotation.md` covers the token write for both host options, the restart and reload check, and the classic-token E16 check.
- 0f23522: `titan-factory bot-token scan` checks A17, the bot's token is absent from every agent environment. When serve reads the bot token it writes the token's SHA-256 to `bot-token.sha256` in its state dir, mode 0600, and removes a stale one when it holds none. The scan, run as the agents' uid, hashes every `ghp_` and `github_pat_` shaped string in this uid's `/proc/<pid>/environ` files, agent-chat briefs, serve and agent logs, transcripts and every row of the factory store, and names each hit by place, never by value. Every place is a flag, so tests run on fixture dirs. It exits 0 when clean, 1 on a hit and 69 with no fingerprint.
- 73c018b: Add the repo-agnostic `build-surface` workflow and `titan-factory build-surface start|status <owner/repo>`. A build spec's front matter names the repo's gate command, evidence path, validators, preview and deploy; the workflow runs slices in dependency waves through an agent-chat implementer route that waits for the agent's exit and reads its fenced JSON report, gates every head, reviews it, fixes under caps, opens the PR, registers it with Shepherd under the implementer's name and deploys after an owner approval. The owner queue carries cards for its `device-check`, `deploy-approve` and `final-walk` gates.
- 9429da9: Add `TITAN_FACTORY_CONFIG` and a global `--factory-config <path>` option to name the factory config file without `XDG_CONFIG_HOME`.
- b945665: Let a console tap resolve an sh-sent-back gate with `await-new-head` (TP-3939 S8). `CONSOLE_STEPS` is now a map from step to the decisions a tap may give: `merge` on approve-merge, `await-new-head` on sh-sent-back. The route intersects that list with the decision enum in the gate's own schema, and refuses any other decision with 403 `class`, so an approve-merge record asking `abandon` or `send-back` now answers 403 `class` rather than 422 `record`. A sent-back gate's PR and head come from its evidence link and prompt; its answer is the decision alone.
- 95a36c4: Let a console tap answer `waive-proof` on an sh-sent-back gate (TP-3626). `CONSOLE_STEPS` now allows `await-new-head` and `waive-proof` on sh-sent-back, still intersected with the gate's own schema, so a sent-back gate that does not offer `waive-proof` refuses it with 403 `class`. A waiver's answer carries the record's head, which the waivable schema pins in its `anyOf` shape; the gate's, the record's and GitHub's heads must still all match.
- f9c1e6e: `titan-factory context-audit` prints wakes by trigger per coordinator: Shepherd digests, Shepherd per-PR notices, Monitor and background task-notifications, agent-chat lifecycle pushes and other broker notices, host-job notices, cron and loop ticks, peer messages, the owner and the spawn brief. Each coordinator's sessions in the window are summed, and only wakes stamped inside the window count. Messages that arrive during a busy turn count too.
- 1f85d07: Add `titan-factory context-audit`: weekly spend by role class, the newest prompt snapshot's layer sizes and instructions files per profile and role, and carried tool-result chars by kind, all read from local Claude Code transcripts. `--assert-rule <marker> <roles>` exits 1 unless each listed role's newest system prompt contains the marker.
- 673bb54: Add the F11 meter for per-identity GitHub rate-limit peaks. Serve's bot identity feeds every bot response's `x-ratelimit-*` headers to a usage meter that keeps the max `used` per resource per reset window, and serve logs a `github-api.usage` line every 5 minutes and a `github-api.peak` line hourly (identity `bot`, resource, used, limit, pct, reset), so the F11 report reads the serve log alone and the token never leaves serve. `scripts/f11-rate-sample.mjs` is the HJewkes-side sampler: run as that identity, it appends one JSONL record of `gh api rate_limit` (core and graphql) per minute, and `--peaks` prints the max `used` per reset window.
- 83ceb23: Honour the owner's claimed plan approvals at Shepherd's merge guard (TP-4284 slice 2). `skill-path` and the `visual-path` glob row clear when one approval names every triggering path. `ci-policy-weakened` clears only when one `ci-policy` approval holds the reviewer's keys and pins every changed path at head, rename sources included, to its exact blob. On a weakened line the evidence step now records `headBlobs` (each changed path's git blob sha at head, up to 20). A failed read leaves the field out, so the row gates. `EffectivePolicy.approved` is attached by each `sh-policy` read and never accepted from a run param or the store.
- f2fc1ba: Record the owner's plan-time approvals (TP-4284 slice 1). A new `shepherd_plan_approval` table holds them, written only by a `plan-approval` console action record, as the console's owner-remote; no CLI, MCP or port path writes it. The scope is a union on `gate`: `ci-policy` pins CI-policy keys and the git blob of each changed file at head, `skill` and `visual` name exact paths. Each approval is claimed by exactly one run, at registration or, when exactly one live registration of the task exists, at the console write; `forRun(runId, task, repo)` reads only the console-written approvals that run claimed for its current task. No merge guard row honours an approval yet.
- 0feb0eb: Add `titan-factory shepherd plan-round <plan>` (TP-4360 slice 2). It reads one PR's planned file list from a plan's `plan-round` fence, a JSON file or stdin, predicts each WHAT gate with the merge guard's own predicates (`isGithubPath` with the plan's `ciPolicyKeys`, `skillPathsIn`, and `visualMatches` over the owning seat's `visual_paths`), pins every file of a ci-policy plan to its git blob sha, and prints a questions-only round.json with a `planApprovals` block for `titan-console decisions file -`. The owner sees each pinned file's changed lines against the base. It only drafts: it writes nothing to serve, the store or the console. `PlanApprovalActionSchema` is now exported so each printed binding is checked against the record the factory will parse.
- 3b403bb: The reconciler has a production bot transport and a `BotPorts` builder (TP-3431 part a). `botTransport(client)` answers the `gates` call with three conditional reads, the open-PR list, the `main` ref and the rulesets, and reports `changed` with the new ETags. A free-plan repo's refused rulesets count as unchanged. It answers the `snapshot` call with `readBackstopSnapshot`. A GitHub failure answers its status, lower-cased headers and message, so the pool classifies it. GraphQL's primary limit, which GitHub returns as a 200, answers as a 403. `buildBotPorts({ client, login, db, clock, observe })` puts the transport behind a `github-api` pool. The pool keeps its state in the factory's pool-state table and probes `GET /rate_limit` as the bot, and the builder sets `conditionalGates: true`. Serve does not use it yet; TP-3431 part d wires it in.
- acb5945: The reconciler now hands observe the ruleset read and a head and tip guard (TP-3431 part b). The gates carry the ruleset list when it changed, and the pass passes it to observe, so `RulesChanged` fires under polling. Before observe runs, `guardVerdicts` runs TP-3097's guard on each open PR's head and classifies the main tip against the cursor. Observe gets a sync `HeadTipGuard` over those verdicts, so it stays pure. A stale head appends no `HeadPushed` and logs `reconciler.disagree class=stale-read`. The guard's compare is a `core-read` pool claim (a new `ancestry` call); `ls-remote` comes from the new `BotPorts.lsRemote`. The start pass now reads the gates too, which saves the extra snapshot after each start. A pass keeps the gate ETags only once its snapshot lands, so a refused snapshot cannot hide a change. `Observe` takes the guard as a fifth argument and `createObserve` no longer takes one.
- dcaebb9: Serve now starts the GitHub backstop reconciler as the bot, and only as the bot (TP-3431 d, I13). The serve verb's new `reconciler` dep builds it from the config file's `reconciler` block, and serve builds its ports over its own bot identity's access: the bot's client, its login, and a `git ls-remote` that sends the bot's token as git's only credential, with the user's global, system and `-c` config, credential helpers, askpass and every transport but https shut out. With `reconciler.enabled` and a bot that is absent, refused or has no login, serve starts no reconciler, logs `reconciler.no-bot` with the reason, and never falls back on the user login's client. `/health` `sources.reconciler` reads `running`, `disabled` or `no-bot`. Each repo's pass logs one `reconciler.cost` line (GraphQL `rateLimit.cost`, REST reads, how many answered 304, and the rows appended by kind), a refused or failed pass included. The bot's Octokit client now leaves every rate-limit wait to the pool (`poolOwnsWaits`). `BOT_LOGIN` sits beside `BOT_TOKEN_PATH`, fixed in code and undefined until ratified.
- 9411e94: Add the `retire-agent` owner op effect (TP-3622). The console-action route runs it under the new RET-OR row. It reads agent-chat's roster again and refuses unless all of these hold: the name's holder still has the confirmed agent id (otherwise `moved {currentAgentId}`), its session has exited, and it implements or authored no live Shepherd run. It then runs a plain `agent-chat agent retire` as caller `titan-console` and answers `retired {name, caveats}`. A `force: true` op is always refused. A replay of the record that retired answers `already`. A broker refusal answers 403 `resolver` verbatim. A broker that is down, or a serve with no `shepherd.agentChatBin`, answers 503. `owner-op.preview` reads a retire-agent op back as `agent`: the holder's roster row, whether it exited, and the live run that would stop it.
- 2256a3b: Meter agent-chat workflow steps from their transcripts and retire an agent mid-step when its slice's budget runs out. `StepUsage` gains `peakContextTokens`, and a code step can throw `CodeStepFailure` to keep what it spent.
- 5993fba: Let the owner approve a g10-held PR now and leave the merge to the adversary loop (TP-4003). A `merge-at-head` op may carry `waitFor: "adversary-loop"`. The factory then records a standing approval on the PR's Shepherd run, pinned to the confirmed head and to the g10 hold class the owner saw, and answers `approved`. The standing-answer sweep lifts the g10 hold as the owner once a g10 release Shepherd writes after the tap judges that hold met at that head, released or in shadow: the two-MERGE rule for `g10-adversary`, the single-MERGE release for `g10-review`. It then answers the run's approve-merge at that head. A new head, a hold escalated to another g10 class, a FIX_FIRST from the panel or the correctness reviewer, or expiry voids the approval and files a "Merge approval voided" owner inbox item. In the console, a g10-held merge-at-head shows "Merge without both MERGEs" (the forced merge, as before) beside "Approve; merge when the loop closes".
- d86059b: Shepherd's merge order is now visible, and a seat can clear it by hand (TP-4098 slice D). `shepherd status` names `merge order: waiting behind #N` on a waiting row and shows the reservation on the reserving row. The timeline logs `order-reserve`, `order-release` and `order-expired` events (migration 41 widens the event kinds). `titan-factory shepherd order [owner/repo]` lists reservations with their age, state, blockers and waiters, and `shepherd order clear owner/repo#N --reason` ends one, logged with the caller. A reservation past its TTL is expired once by its own run in the new `sh-order-expire` step, which tells the seat once. The order wait also stops waiting on an `ahead` run that left its merge step without merging (TP-4103).
- b4e7b9d: Add the `close-pr` owner op (TP-3939 S4). The console tap closes the PR only while GitHub shows it open at the head the owner confirmed, keeps its branch, then ends the PR's live Shepherd run. A PR open at another head answers `moved` and is not closed; a PR closed with no ledger row for the record answers `gone`; a replay after the ledger's `done` answers `already`; an earlier call that logged `started` and no `done` re-reads GitHub and finishes. The console-action route gains the `pr-closed` outcome (200, with `closedHead`), and the owner-ops ledger gains `read(actionId)`. The authority table still denies `close-pr` to owner-remote until the `pr-close` row (TP-3939 S0) lands.
- 8efba6c: Add the `deploy-pause-clear` owner op (TP-3939 S6). Under the deploy lock, the console tap removes the failure pause a rolled-back deploy left, and only while the pause file still names the record's `pausedAt` and `target`. A newer pause answers `moved` (with `currentPause`) and stays. A running deployer is refused `deploying` (409). The manual hold is never cleared; when one stands, the answer's `stillHeld` names it. No pause plus the ledger's `done` answers `already`; no pause and no `done` answers `gone`. The route gains the `pause-cleared` outcome (200, with `clearedPause` and `stillHeld`). `owner-op.preview` returns the pause as `/health` reads it, whether a deployer is running, and the manual hold. The authority table still denies the op to owner-remote until the `deploy-resume` row (TP-3939 S0) lands.
- e794985: Add the `merge-at-head` owner op (TP-3939 S3). A console tap never merges directly (MRG-OR): if the PR's Shepherd run is already pending on approve-merge at the confirmed head, the tap resolves that gate as owner-remote; otherwise it starts a `land-pr` run with the new `update=false` param, which stops `behind` instead of updating the branch, and records a standing answer in `<stateDir>/standing-answers.jsonl`. A new standing-answer sweep resolves that run's approve-merge only at the exact head the owner confirmed, within 24 hours, and only while no owner-asked hold or repo freeze stops the PR. After the land run completes, the sweep ends the PR's live Shepherd run if GitHub shows it merged. A replay of the same record answers `already`, `moved` or `gone`. The console-action route gains the `accepted` outcome (200).
- c9929bf: Split the console-action route into `console-action/{route,record,outcome,gate,release,op}.ts` and teach it typed owner ops (TP-3939 S2). A record that names an `op` (the owner-queue `OwnerOp`) instead of an `action` is checked against the authority table as owner-remote: a denied op is refused 403 `class`, an unknown kind 422 `record`. An admitted op runs its kind's effect between a `started` and a `done` line in the new `<stateDir>/owner-ops.jsonl` ledger; no kind has an effect yet, so every op is still refused `class`. Existing resolve-gate and owner-release records read and answer as before. New read command `owner-op.preview` returns an op's authority decision and the live PR (GitHub and Shepherd) or gate it names.
- 015b36d: `digest run` writes `owner-gate-alarm.md` beside the digest when the stale-gate alarm fires and removes it when it does not. Planner inputs gain `optional` (an absent file reads as empty) and `prompt` (a brief line shown while the input has text), so the planner review can read the alarm and be asked for a cause fix (TP-4546, TP-4368).
- 763497e: Add `titan-factory planner wake --config <path>`, the factory-planner timer's entry. It hashes the planner's configured inputs (files, task directories, command output such as merged PRs) with timestamps normalized away, and exits 0 with one line when they match the last run, so an unchanged factory costs no model call. Files the planner writes itself are re-baselined after each spawn. The spawn profile is configurable (`profile`, or `--profile`) and defaults to `opus-coordinator`. Inputs marked `digest` are copied into a pre-digest file, cut to `digestMaxTokens` (60k by default), and the brief points the planner at it first.
- 05931b4: Shepherd seat digests send deltas. A seat's first digest still lists every open item; after that a digest lists only new open items, one `Cleared:` line of PR refs for items that cleared, and newly finished runs, with unchanged gates folded into one count line naming `titan-factory shepherd waiting` and unchanged seat-fix rounds, which that command does not list, still listed in full. Three or more new gates on one step share one line that still carries each gate's resolve command. Seat memory gains optional per-item PR refs, so an existing `seat-digest.json` still loads.
- 62f0e26: Pace Shepherd seat digests under `shepherd.seatDigest.pacing` (TP-4207): a new gate or seat-fix item sends after a settle window, and finished runs and cleared items batch until a flush time or batch size. With no pacing config, digests go out as before. A PR whose item moves from one gate to another now reads as `Changed:`, not `Cleared:`.
- 2ecccb6: A planner can let a Shepherd run's fix rounds merge the base branch when the fix needs code that has landed there since (TP-4242). `titan-factory shepherd allow-merge-base owner/repo#N --reason <text>` records the exception on the run with the caller, and `revoke-merge-base` drops it. While it stands, a ci-red fix round's brief no longer says "Do not merge the base branch". Every fix-round brief except a conflict's then says the fixer may merge the base, and a fenced `merge-base exception` block names who allowed it and why. The exception follows a registration to the run that replaces a failed one, and one that cannot be read counts as none.
- 423c9ce: `shepherd prs` rows now carry what `gh pr checks` prints. `ci` gains `checks` (the newest run per name with its status, conclusion, times, link and title), `statuses` (the head's commit statuses, which the PR snapshot now reads beside its runs on the same cadence), `required` (the run's land-rules contexts) and `settled`. `ci.head` is the sha the cached runs were read for, so a list whose head moved since shows the mismatch. `CommitStatus` gains optional `targetUrl`, `description`, `createdAt` and `updatedAt`, mapped by the gh-cli wire.
- 82593bc: Add `titan-factory shepherd watch <ref> [--on merged,stopped,gated] [--seat <name>]`, `shepherd unwatch <ref>` and `shepherd watch --list` (TP-4208), backed by the new `shepherd.watch` command. A watched run's named events are prompt-class in the paced seat digest, so they arrive after the settle window rather than the batch flush. `--seat` sends a seat-book seat a copy while the run's own seat keeps its lines. A watch is dropped once a digest sent to the watching seat carried the run's end, and it is kept in the factory database, so it survives a serve restart. Watching a PR Shepherd has not registered exits 1 with the reason.
- 1640772: Shepherd: `shepherd.taskClose` picks when a merged PR closes its `--task` (TP-4274). `keep`, the default when absent, closes it on every merge as before. `last-slice-only` closes it only on the last slice: a `Last slice: yes` line in the PR body, `shepherd register --last-slice`, or no other open PR registered with the same task and no `Last slice: no` line. Otherwise the task stays open and gains a `slice merged: <owner/repo>#<n> at <sha>` note. Migration 43 adds the registration's `last_slice` column. The coordinator adds `shepherd.taskClose` as a live editable factory row.
- 38dbe89: Add `titan-factory shepherd brief <owner/repo#N> [--format md|round-section] [--images <dir>]` (TP-1696): it prints the owner PR section for a PR waiting on its approve-merge gate, built by `buildOwnerSection` from the PR (GitHub), the run's pending gate, latest verdict and owner brief (Shepherd) and the task title and done_when (active-work). `--images` pairs before and after shots from `<dir>/pr-<n>/manifest.json`, and never offers an after-only set. It writes nothing to GitHub or Shepherd.
- 44038c9: Shepherd no longer asks the owner to merge a fix-first-runaway or no-progress head (D8, `GATE_DEMOTIONS.fixFirstRunaway`, on by default). One fresh reviewer gets the run's FIX_FIRST trail as a convergence review: its MERGE takes the normal land path, and its FIX_FIRST sends the repo's seat (or the hub seat) a `fix-first-planner` notice while the run waits for a new head. A moved head re-arms the review. The reviewer brief gains `convergence`, which asks for a `Convergence:` section tagging each open finding Important, Nit or Pre-existing.
- 9161fc8: `shepherd stats --reviews` labels each review round with its cause (first, fix-round, convergence or other), its panel member's shape and whether its brief was scoped (review-stats schema v2; v1 rows are relabelled on the next refresh). It adds a shape-and-cause cut, token distributions, and fix-round p50/p90 dollars and tokens per shape before vs after the first scoped round or `--since-scoped <date>`, split scoped vs full. Each panel member's verdict now resolves its own round.
- 99c030c: The spawn gate reads measured headroom. A review now adds `reviewLoad` 0.05 cores to the load it is compared with, not 4: a 2026-10-29 sample of a 48-core host had reviewers running no tests and every claude process together at about 0.3 core. A new `spawnGate.minIdleCores` (default 1) refuses any spawn while the core count less load1 less the unabsorbed reviews leaves fewer cores idle; it is not applied where load1 or the core count is unread. `review.maxConcurrent` stays the backstop on how many reviews start. Deferral and admission lines show load1 and the core count.
- 377cca9: Shepherd dispatches reviews from one queue. A review queues once and starts from the queue's front on three triggers: when it is queued, when a review ends, and on a one-minute tick while any review waits. A deferred review no longer sleeps and asks again on its own, so nothing polls per pull request, and the rule that dropped an ask that stopped asking is gone. A queued review whose pull request moved to a new head or closed is dropped and its step told at once. A review still queued after the 3 hour machine-hold ceiling gives up as before. A queued review whose step is cancelled or shut down leaves the queue at once and never starts.
- f1d79a5: Load is now the only limiter for factory spawns. The spawn gate's `windowMs` and `headroomIntervalMs` default to 0 and reload live, like `load5`. Coordinator's editable fields list both as live factory rows (0 to 3,600,000 ms). `burstMax` meant nothing without a window, so a config that still sets it fails to load with a message saying to remove it. When the gate would admit a review, any asker within the first N of the queue goes, where N is the free review slots the load check also allows. Fixers still sort first, then the oldest intent. A review counts as unabsorbed from the moment it is admitted until the roster shows it running, so a burst can no longer overshoot `buildLoad5`. A queued ask whose PR moved to a new head, or left the open list the PR snapshot already read, leaves the queue at once instead of aging out.
- f77d79d: `ciPolicyLabelledLines(text)` lists every labelled line a MERGE block's `ciPolicy` folds, each with its own reading, through the same reader `parseVerdictBlock` uses. The factory adds the read-only `gate.ownerEvidence` command (TP-4489, the first slice of TP-4404): the console card for an owner-at-head approve-merge gate is projected from the merge evidence the gate was opened on. Its facts are recomputed with land's own functions and must equal the gate's marker, unknown names included; a CI-policy section heads with the stored reading and shows the verdict text only when the shared reader still reads the same. A gate whose facts need file sections reads `missing` until they land.
- 908cdbd: `gate.ownerEvidence` now shows file sections (TP-4490, the second slice of TP-4404). The paths come from the evidence's own `merge.changedPaths`: `.github/` files for a CI-policy fact, repo skill files for `skill-path`. Both sides of each path are read by blob sha against the merge base. A file reaches the card only when both sides decode to their blob's bytes, the head matches the evidence's `headBlobs` pin, the blobs differ, and the shown rows (through the new reversible `exactLine`) rebuild the head bytes from the base. Otherwise it reads `missing`. A `files-unread` gate always reads `missing`.
- a719f18: A console tap can now answer an owner-at-head merge gate (ci-policy-weakened, ci-policy-malformed, skill-path). A ready `gate.ownerEvidence` card carries a sha256 digest of its body, and the tap's record carries that digest as `evidenceDigest`, plus a `presence` statement: a `titan-factory.gate-presence` statement the owner's key signed over the gate and the answer `{decision, headSha, evidenceDigest}`. The factory reads the card again from the same stored evidence, verifies the statement against the root-owned owner key ring, spends its nonce once in the gate batch ledger, and resolves only when the digest matches and the gate and PR are still at the confirmed head. Any agent can read the digest, so it never stands in for the owner. A resolved outcome names the facts the tap covered. A tap with no digest or no presence statement is refused `class` with the terminal command, a changed or missing card is refused `evidence`, a statement the owner's ring does not verify for this answer is refused `resolver`, and a digest or statement on a gate that needs no evidence is refused `record`.
- 6365309: The console's confirm sheet for an owner-at-head merge gate shows the factory's evidence card (TP-4492). `inbox.prepare` reads `gate.ownerEvidence` for a merge tap. A `missing` card, or one read at another head, offers no tap and names the terminal command. A ready card goes into the read-back and so into the confirm digest, and the record posts its `evidenceDigest`. The sheet heads each CI-policy section with the evidence's own reading (kind and keys). It lists every labelled line and the verdict text, and shows each changed file's rows. Every string renders verbatim, wrapped, never clamped or cut. In the factory, a card's CI-policy section now carries `verdictLines` and labelled lines through `exactLine`, in place of the raw `verdictText`, so a hidden or bidi character shows as its code point.
- 00aea59: Add `titan-factory review owner/repo#N [--head <sha>] [--json] [--wait-ci]` and `titan-factory review resolve <fingerprint>`. The CLI runs `@titan-design/review-workflow`'s runner on one PR head with ports built from `shepherd.review`, with no Shepherd run. It prints the outcome, the member dispatches and any fixer fingerprint. Only `MERGE` and `carried` exit 0, and `needs-update` is printed for the author, never acted on. The CLI posts nothing to GitHub. Its runs and parked fingerprints live in `review.sqlite3` beside the factory database.
- 24af4ac: Shepherd answers an open approve-merge gate from the owner's console Ship (TP-2078, decisions item 97). Where `shepherd.consoleAnswers` is configured, serve runs a 60 s round ship sweep over its `roundsDir`. For each PR with a pending approve-merge gate, the round built last for that PR decides: an earlier Ship never outlives a later re-ask, Don't ship or Send back. Its answer goes through `roundMergeDecisions`, so it counts only at the gate's exact head, only on a seat-policy or authority MRG-AU gate, and only within 24 hours of the submit. A held PR stays pending. The gate resolves as owner-remote `titan-console` on channel `console:round-ship`, with the round and submit time in `confirmEvent`. The merge step still checks every hold.
- fc15ece: Shepherd sends seat notices, exit notices and the seat digest to the session that registered the run (TP-3653). `shepherd register` records `AGENT_CHAT_NAME` as the run's registrant, and only the first one is kept across restarts and successor registrations. An implementer that registered its own PR has them sent to the first session that spawned its lineage. A run with no registrant still goes to the repo's seat. A registrant stands in only for a repo with one seat: a denied, unseated or `+` joined repo still sends nothing and opens the owner gate. Adds factory migration 38 (`registrant`, `registrant_fixer` on `shepherd_registration`).
- 71eddd7: Land merges a green head as it stands in a repo that does not require up-to-date heads, even after its base moved past the green. There is no land-time update-branch any more. Shepherd no longer chases a busy main through new heads after a MERGE (tp#2054). Strict repos still update a behind head as before.
- a42e161: `shepherd.review.workflow` takes `off`, `shadow`, `on:preflight` or `on`, and an absent key means `off`. Under `shadow`, each review round records `sh-review-shadow:<head>`: review-workflow's preflight decision, the round's failure classes and the policy action it would take. It is computed from the round's records and starts no session. `on:preflight` and `on` run as `off` with a logged reason until they ship. `shepherd stats --review-shadow` reports the shadow per repo and ISO week.
- d130bd8: On a red main, Shepherd now reruns the failed jobs at the red sha once per freeze episode (`sh-main-rerun`, decision 525). If every red job comes back green in Shepherd's own rerun, the repo thaws at the red sha. The rerun runs alongside `sh-spawn-fixer`, so a deterministic red never waits on it, and after a thaw the fixer keeps working the flake task. The fixer brief tells a flaky-test fix that changes only tests to register `--kind test-only` with no mutation spec. A rerun someone else started never counts; the rerun is read with every attempt kept (`checkRunAttempts`), since GitHub's default listing shows only a job's latest attempt. The thaw re-judges main at the red sha first, so a check still running at the red or a red required context from another app keeps the repo frozen, and it holds only while the episode's red sha is still the one rerun. Before the thaw, the episode's fix task becomes a flake task: both runs' ids and URLs, the job names, the failing tests and an error excerpt are appended, the task is tagged `flake` and reopened if it was done, and its `done_when` asks for a root-cause fix, not a retry, a timeout bump or a quarantine. The filed `done_when` is replaced with `force`, which active-work requires, and the notes go last. If the task cannot be updated, the repo stays frozen, and an active-work refusal (`FixTaskRefused`) ends the step at once instead of being retried as an outage. A failing test that already thawed main this way within 24 hours stays frozen as before. The fix-task port gains an optional `markFlake`.

  `fileFixTask` no longer replaces an episode's fixer or fix task with a standing fixer from an earlier red. A fixer the episode gained while the standing fixer was looked up keeps its freeze exemption.

- f8c35d0: `titan-factory shepherd thaw <owner/repo> --red-sha <sha> --reason <text>` thaws a main-red freeze by hand, so the freeze keeps a manual way out once the `main-red-again` and `main-frozen` owner gates go. It refuses a repo with no open main-red episode, a `--red-sha` that is not the episode's current red sha, and a blank reason. A thaw goes through `FreezeStore.release`, the path the gates' `unfreeze` answer uses, and records a `thaw` event naming the caller and `hand thaw: <reason>`. It cancels the episode's pending `main-red-again` and `main-frozen` gates through the thawed-main-gates sweep, leaves the fix task open, and alerts the repo's red seat by the main CI watch's red-event route. An alert that cannot be sent is logged as an error line and never fails the thaw.
- 738e2d9: Add `titan-factory shepherd fix-pr <owner/repo> <pr> [--episode <n>]` (registry command `shepherd.fix-pr`, served over `/rpc` like `shepherd thaw`). It marks a registered pull request as the open main-red episode's fix through `FreezeStore.markFixPr`, recording the caller, so a seat's own fix merges through the freeze while every other pull request stays held. It refuses a repo with no open main-red freeze, an `--episode` that is not the open one, a pull request not registered with Shepherd, and a second fix PR for the same episode. A run waiting on `repo-not-frozen` merges on its next read with no re-register, and an approve-merge gate the freeze alone caused is superseded at once. `shepherd freezes` now also lists open main-red episodes with their fix task, fixer and fix PR, and the marked PR's `timeline` shows the mark (TP-4204).
- 8cab3c4: Add `decodePngBounded`, a PNG decoder for snapshot blobs a pull request supplies (TP-4320 S3b). It walks every chunk before it inflates anything: exactly one IHDR, first; consecutive IDATs; nothing after IEND; 8-bit RGB or RGBA only, not interlaced; width × height at most `maxPixels`. It then inflates with a zlib `maxOutputLength` taken from the checked header, so peak memory stays bounded whatever the bytes claim. `snapshotShare` and `contentBox` now take decoded images, and pngjs is a test-only dependency.
- 4f873ff: Add `shepherd.visualThreshold`, a per-repo config key read live at each merge evidence step, with mode `off` or
  `shadow`. Under `shadow` the evidence records `visualDelta`: the snapshots the PR changes, added or removes, and the
  public API, token and harness paths it touches. No blob is read yet, so every changed snapshot records as `unmeasured`
  with reason `not measured yet`. The measuring caps (`maxSnapshots`, `maxBytes`, `maxPixels`, `maxTotalPixels`) have
  ceilings config cannot raise, and the record's schema bounds every list and string, so the evidence comment stays under
  GitHub's size limit. The merge decision is unchanged.
- db14121: The evidence step now measures each changed snapshot from the merge base to the head under `shepherd.visualThreshold` shadow (TP-4320 S3c). Each blob is read with `fileBytes(…, { maxBytes })` and decoded through `decodePngBounded`, whose pixel limit is the step's remaining `maxTotalPixels` budget; pairs run one at a time with a yield between them. Over `maxSnapshots`, an unreadable merge base, an absent or oversized blob, a decoder refusal and an exhausted budget each record as `unmeasured` with a reason. The merge decision is unchanged.
- 90493f9: `shepherd.visualThreshold` accepts mode `on`, and under it the merge decides on the measured visual delta (TP-4320 S4). A public API report, a token path or a visual harness path gates on row `visual-path` whether or not a seat glob matched it; so do a snapshot above `maxChangedShare` (naming its component and share), a removed snapshot, an unmeasured one and a delta that fails its schema. A changed baseline measured at or below the threshold, or an added snapshot, no longer gates, and the allow names how many snapshots changed and the largest share. Any other changed baseline, and a red or missing baseline check, gate as before. Under `shadow`, `off` or with no delta the decision is unchanged.
- 474beb4: Shepherd gains a `lan-gates` hold class for gates that cannot run in GitHub Actions (TP-4396). The reason names the gates, `lan-gates: <gate>, <gate>; <detail>`. `shepherd hold` refuses with exit 65 an empty or badly spelled list, or one that names a gate never declared. Migration 47 adds the gate catalog and an append-only evidence table. The hold is never lifted by evidence: a merge read at the PR's head, as read just then, passes it only while every named gate's newest record at exactly that head is green, so a later push is held again. Merge order and the restart drain read the same clearance at the head the run's merge step is at, so a run green there keeps ordering its peers and a restart waits on its merge.
- e108fca: build-surface routes a red gate by its record's `failure.class`. `code`, and an absent or unrecognized class, goes to the fix round as before. `infra` probes the spec's optional `gate.health`, reruns the gates once, then parks on the owner gate `infra-park:<slice>`, and counts no fix round. `gate-broken` and `spec` stop the slice and file a task, one per failure signature as grouped by `@titan-design/cluster`, so a repeat finds the task already filed.
- 8717eb0: Add `titan-factory blocker raise|clear|list`. Any seat raises a hard blocker as an owner-inbox deposit carrying `blocker { since, blocks }`, within the per-asker cap of five open deposits; a repeat raise of an open slug keeps its first `since`. `raise` prints the item id, then the console inbox link from `titan-console inbox link` run through the configured `shepherd.visualDelivery.console` argv; with no console configured or reachable it prints the id alone. `clear` withdraws it through the spool's withdraw audit log, recording the actor beside the asker, and `list` prints open blockers oldest first, or as JSON with `--json`.
- 598e8d1: A build-surface slice can set `preview: false` or `deploy: false` to skip that step for itself; the slice's outcome records the skip. Absent inherits the spec, and `true` cannot enable a step the spec leaves out.
- 3d709d8: Offer a forced retire on the agent page once agent-chat's grace has passed (TP-4600). `listAgents` passes through each row's `exitedAt`. The factory's retire-agent route sends `--force` only when the roster's exit time is at least two minutes old, and its preview reports `forceStop`. The console's Retire sheet reads back the exit time and offers "Retire and discard" only when `forceStop` is null, with the same CHANGED re-check at act time.
- 84114b3: `shepherd.repos.<repo>.statusContexts` names commit-status contexts that count as the repo's CI beside its Actions check runs. Land's ci-wait, its open-repo rule and `sh-main-ci` read each as a check run: success is green, pending or not yet posted holds, failure or error is red. Repos without the key read as before (TP-4645).
- 7012bf0: Shepherd's fix-proof gate takes CI as the proof for a PR whose diff is only `.github/workflows/**` (changesets and the repo's declared generated files may ride along), since no unit test can cover a workflow edit (TP-3861). `sh-fix-proof` then reads the base branch's required checks from check-runs instead of the fix-proof run: it records a `workflow-ci` read citing each required check's newest run at the merge base and at the head. The read passes when a required check concluded failure at the merge base and every required check concluded success at the head; otherwise the review ends as NO_REPRO carrying the read. A passed read reaches the reviewer as `workflowCiProof`, a new `ReviewerBriefInput` field, and the brief names CI as the proof and tells the reviewer not to ask for a unit test; the tests panel member reads it in place of the missing-result line. A mixed diff keeps the fix-proof run path unchanged.

### Patch Changes

- 11dd187: The D-M1a-01 A17 case, "the bot's token is absent from every agent environment", now runs in both event-source modes under `a17Event`. Each mode stores a push through its own ingress or reconciler pass, dumps the feed's factory database as the scan's store place, has serve's bot identity publish the fingerprint from a synthetic token file, and asserts the leak scan is clean across env, briefs, logs, transcripts and store. Test only; no production code changes.
- eeed49e: The A17 harness feeds now go through production entry points: the webhook feed posts signed deliveries to the ingress's `answerDelivery` with a test HMAC secret, and both modes run `startReconcilerSweep` (the 15 s due-check schedule and the reconciler's `observe`) over the github-api pool with a fake clock. Test support only; no production code changes.
- 11b8503: The M1a A17 cases for D-M1a-03 and D-M1a-04 now run in both event-source modes under `a17Event`: "a header-less secondary-limit 403 is Unavailable with a 60 s wait" and "an Unavailable read writes no marker and counts no re-drive" drive the bot's `github-api` pool on the reconciler, and "a stale head read moves no epoch" drives the head guard over the feed. The harness feed gains `limit`, `reads` and `head`, keeps its pool state in the factory's pool-state table, and runs the pool on the feed's clock. Test support only; no production code changes.
- 2c5dccc: Adds F11's comparator in `event-log/agreement.ts`: `kindCensus` (clock 1, polling: every declared kind has a backstop row) and `agreement` (clock 2, webhook: matched, webhook-only, backstop-only, pending and divergent-key rows from the window's rows and the reconciler's duplicate lines). Both are pure, and only `event-log/` and tests may import them (I7). The A17 harness feed now carries PR, review, push and ruleset facts as well as CI, and the harness's own A17 cases check that a scenario covering every reconciler kind yields the same occurrence keys in both modes, less the declared transients, and that a re-observed occurrence is never a second row.
- b40ff39: Add the A17 static structure guard: a test fails when an A17 event case bypasses `a17Event` or is skipped, with a `NOT_EVENT` allow-list of single-mode cases, and document the dual-mode harness in the factory guide.
- b7c8320: `DispatchRequest` takes an optional `worktree`, passed to `agent-chat agent spawn` as `--worktree` so the agent adopts that path. Autoresearch implementers now adopt the engine's idea tree, which sits at the ratchet head, instead of working in a fresh worktree cut from the clone's default branch, and an exploit lane no longer moves a tree the agent already sits in.
- cfdfb64: The autoresearch planner's round-1 brief now carries the run and target, the adapter's `program.md` (inline, or its path when the clone lacks it), the `target.json` and `bounds.json` paths, the quotas, and the queue-ops JSON Schema derived from `QueueOpsSchema`. Resumed rounds restate the end contract in one line.

  Both briefs state this round's quotas with their numbers (minimum pool, the net adds it takes, the kept ideas owing a follow-up), worded by `quotaRules` from the run's settings.

  An implementer spawn passes `--worktree` only when the configured agent-chat's `agent spawn --help` lists it, read once per binary; an older agent-chat gets a fresh worktree and a `[no-adopt]` warning instead of a refused spawn.

- cfdfb64: A planner answer whose final message held no JSON is now reported on the plan step as `malformed` and gets the same one resumed retry a quota miss does, with the parse error as its violation, instead of failing the run. The factory reads agents' final messages whole, so an answer past 16 KiB keeps its closing fence.

  `titan-factory autoresearch plan-dry-run <target>` runs only a round-1 planner turn on an empty digest and checks its ops against the parse, the queue-ops schema and the quotas, with no pin, baseline or implementer.

- 1a37048: `/health` `build.behindMain` and the deploy ALARM in `titan-factory shepherd status` no longer count commits the deploy pacer skips because no changed path reaches the factory build (docs-only, other packages, version-only release bumps). An unreadable build closure, or a compare file list that is missing, empty or capped, still counts every commit, and a moved file counts by its old path too.
- 4768c62: build-surface stops a slice whose report requests new design-system components, with the non-retryable stop `needs component: <items>`, instead of dropping `newPrimitivesRequested`.
- 25fcc67: Move the return-contract report parser into session-analytics. `parseReport` now lives there, reads the `Head:` sha and the `CI:` paste (worst state first) as well as the status, PR, plan, PARKED line and proposed tasks, and accepts a sentence after the status word (`Status: DONE. Plan: ...`). session-analytics also exports `extractFriction`, `extractConcerns`, `lineCluster` and `clusterOf`. factory keeps only the `burndown-slices` reader. session-miner gains `titan-miner report intake --shadow [--since 24h] [--eval]`, which writes one row per worker report (status, PR, head, CI, concern classes, suggested actions), acts on nothing, and with `--eval` scores the suggested closeouts against what happened next in the event log.
- b48c396: In an agent env (AGENT_CHAT_AGENT_ID set) with no titan-factory serve answering, `land`, `resume`, `toolchain fanout` and the shepherd verbs that write (merge, review, release, hold, resync, repair-stop, repair-go) now exit 69 with the same unanswered-serve message `register` uses, instead of running in-process. Each verb probes serve once and uses that one answer both to pick serve or the local path and to refuse. `resume` and `toolchain fanout` gain `--port`. `gate resolve` is unchanged: its in-process work is a database write the resolver policy already governs. Read verbs keep their local fallback; without the env var nothing changes.
- 83a5759: Recover a CI job that GitHub leaves queued or in progress after its workflow run has completed (TP-3996). `ci-wait` used to count such a job as a runner backlog and waited on toward the 135-minute ceiling with the merge train held. Now, once the job's run reads completed for 5 minutes, land reruns that one job in a recorded `ci-orphan-rerun` step, once per head. If the head orphans again, the run fails as a `ci-timeout`. The GitHub port gains `workflowRunStatus` and `rerunJob(repo, runId, jobId)`, which reads the run before it posts. The fake now reads a run with an open job as not completed.
- 4bdfa07: A Shepherd run no longer fails when a `ci-wait` window times out on a wait only GitHub can end (TP-4180). If the last read before the timeout saw `mergeable_state unknown`, an open repo's unconfirmed second read, or an HTTP 5xx, land waits again in a fresh `ci-wait` step, up to `CI_WAIT_ATTEMPTS` (3) windows in a row. Once the checks go green the run goes on to review with no re-register. A red check still ends the wait at once. When every attempt times out, the run fails with `ci-wait timed out after <ms> ms on each of 3 attempts: <last read>`. `shepherd timeline` shows each timed-out window as a `ci-timeout` event that names its attempt.
- a4a48c9: A coordinator may acknowledge a `main-ci-timeout` gate without the owner's presence dialog once the base branch's tip contains the merge sha and is green on every required context, the evidence Shepherd's own clear of the gate reads. A base with no required contexts, a red or pending tip, or a tip off the merge's line falls back to the dialog (TP-4285).
- 2f62731: A `shepherd-merge-guard/ci-policy-weakened` (D21) approve-merge gate now asks the owner again at every head: an earlier approval never answers it, and an approval given at it follows to no later gate. Its brief no longer recommends merge on the reviewer's MERGE; it reads "The reviewer judged CI policy weakened; read the card and the diff; no recommendation."
- 2bfca9a: `service deploy --expect <sha>` now deploys origin/main when the deploy checkout's main is already past `<sha>` and on origin/main. Before, it refused with "already past", and the deploy pacer held that ask until it went stale. A rollback restores the build but leaves the checkout's main where it was, so after a rollback every older ask was refused this way. The refusal stays for a checkout's main that has commits not on origin/main.
- f765e50: Keep a queued redeploy sha when an older merge whose own main run goes green late is queued after it, instead of letting the older sha overwrite it. When the deploy checkout does not hold either merge yet, the ancestry probe fetches main's objects (no ref moves) and asks again.
- bf425db: `service deploy` no longer skips an asked sha whose own range reaches no factory path while origin/main already holds factory commits past it: it judges the running build..origin/main and deploys main instead (TP-3890).
- 099e944: The deploy watch no longer rolls back a build because runs in flight replay-diverged under it (TP-3889). `/health` lists `recoveryReplayDiverged` (runs strict replay parked for the diverged sweep) and `divergedRestarts` (runs the sweep restarted, with a successor that exists). The watch leaves both out of its count and reports them in the deploy output; a run that fails, or parks for any other reason, under the new build still rolls back.
- b5dd1a7: Shepherd's replay-diverged sweep no longer spends an owner's merge answer. If the owner answers a parked run's approve-merge gate with `merge`, the sweep merges the PR at that head instead of restarting the run, provided the head has not moved and land's own reads pass: required checks green, not behind on a strict repo, no conflict, and the base the gate named. The run ends with a `sh-carried-merge` step that names the gate. Any other answer, a moved head or a failed read restarts the run as before (TP-3918).
- 9c8117e: Remove `confirmOwner`, the owner-presence mode that returned the helper's bare proof id. Nothing called it once `gate resolve` and `shepherd owner-release` moved to signed statements; owner presence now only runs the helper's `pubkey --id` and `sign`. The helper path checks are unchanged and are tested through `signStatement`.
- e339aa7: Add the A17 dual-mode test harness (TP-3808): `a17Event` registers an event case under both `sources=webhook` and `sources=polling`, and `factoryMigrations()` is exported from the host so the harness opens the same schema as serve.
- f10e90e: Add the A17 runner (TP-3825): `pnpm --filter @titan-design/factory a17 --out <path>` runs every A17 case and writes an `a17-report/v1` report, exiting non-zero when a case lacks a mode sibling or either mode did not pass.
- a80e617: Consume `@titan-design/autoresearch` for the autoresearch engine and recipe. factory keeps the workflow definition, the evidence-wrapped routes and the ratchet fast-forward.
- 6abf7b8: serve reads the bot token from `BOT_TOKEN_PATH`, now `~/.config/titan-factory/secrets/github-bot.token` under the home dir in serve's passwd entry (TP-3094 option B). The README documents the owner's token write and the accepted same-user residual.
- 19495d5: While a run's ci-wait is polling, `shepherd status` and `list` name the head that ci-wait last read, not the head of an earlier recorded step, so a PR pushed mid-wait no longer looks pinned to its old head.
- ad9c9a1: A Shepherd conflict against a base that moved past the fixer's merge-main now counts as a new conflict: the fixer is woken again instead of the run being demoted to the seat. A new recorded step, `sh-conflict-base`, reads the base sha and whether the head contains the base recorded at the last conflict; a failed read counts as the same base, so the D9 demotion still applies.
- 50f0f76: Document the F11 gate in the factory guide: the two clocks, what resets one, the meters and the commands for each, with pins from the guide to the rate sampler's flags and the reset paths.
- 628c01f: Adds the F11 report (TP-3103 F6). `event-log/f11-window.ts` reads the event-log rows observed in `[since, until)` over a read-only connection, and `event-log/f11-report.ts` turns them, the serve log and the HJewkes rate sample into one report: the kind census (polling clock) or agreement (webhook clock), disagree-class and `head-regression` counts, distinct check run ids per (sha, check), and each identity's peak against 50% of its limit. `pnpm --filter @titan-design/factory f11` runs it offline and writes JSON plus a markdown section; nothing runs in serve.
- 74720c9: The fixer note on a console Send back now carries the owner's frame feedback: `frame <key> (<verdict>): <comment>` and one `  pin <n> at <x%>,<y%> [<target>]: <note>` line per pin, read from `feedback.json` `variants[]`. The general note is kept whole under the 4000-character cap and frame lines are cut first. A Send back with only frame comments is no longer refused as having no note.
- e2b6ca1: Shepherd's main-red fixer sweep now treats an `agent park` refusal saying the worktree "is not on disk" as already parked: it retires the fixer, so the next sweep skips it instead of logging "left an ended main-red fixer" every ten minutes. Any other refusal still leaves the fixer and retries.
- 3184af7: Document the `github` config block as a permanent, supported polling configuration: `github.sources`, `github.ingress`, `github.pollingIntervalMs` and `github.backstopIntervalMs`, the effective-mode table, the no-restart kill switch, and `health.sources` including `lastPassAt`.
- 68fd0b4: Log a `head-regression` line where the head-wait, moved-gate and ci-wait checks read a head behind the held one; observe-only, no answer changes.
- 21c2baa: `/health` gains `deployHeld: {held, since, reason, source}`, read from `deploy-hold.json` through the same reader the deployer uses, so a manual or Morning deploy hold shows beside `deployPaused`. A missing file reads as not held; an unreadable one reads as `held: null` with a reason.
- a1fb5db: `/health` gains `deployPaused: {paused, since, reason, lastRollback}`, read from `deploy-pause.json`, so a seat can see a deploy pause without running `service pause`. A missing file reads as not paused; an unreadable one reads as `paused: null` with a reason.
- 71054b3: A review the spawn gate has deferred now reads its pull request's head on every pass of the queue and, when the head moved, finishes superseded and leaves the queue, so no reviewer is started for a head the PR already left (TP-4487).
- 80bb5ab: Turn merge order on for titan-platform (TP-4098 slice C). A conflicted Shepherd run now reserves the paths it changes, lets overlapping runs already merging land first (a run held in its merge step behind a live reservation does not count, so runs never wait in a ring), then gets one conflict wake at the base they leave. Overlapping runs that reach their merge step later wait behind the reservation until the conflicted PR lands. The reservation is released when the run ends.
- a4e4bd8: Add a merge-order reservation store (migration 40), a path-overlap rule and a merge guard chained last in the hold chain. It ships off: `merge-order.json` disables it for every repo and nothing writes a reservation yet, so merges behave as before.
- cf0e22e: Shepherd keeps one main-red fixer per freeze episode. `setFixer` no longer overwrites a fixer the episode already recorded, so the first spawn wins. `sh-spawn-fixer` names the fixer from the episode's first red sha, not the run's own merge sha, so concurrent runs agree on one name. It reads the episode again just before the spawn, and retires a fixer it spawned when another fixer was recorded meanwhile. A run whose PR is registered on the episode's fix task but is still frozen (no fix PR marked, and the implementer is not the recorded fixer) tells its seat once per head after `THAW_STALL_ROUNDS` thaw rounds, naming the `titan-factory shepherd fix-pr <repo> <pr> --episode <n>` command.
- 8354b79: Add `--verify <ref>` and `--pin-from <ref>` to `titan-factory shepherd plan-round` (TP-4360 slice 3). `--verify` prints no round and exits 1 when the ref changes a path the plan does not list (rename sources included), a ci-policy plan's pinned blob differs at the ref, or a file pinned absent exists there; each `drift:` line ends with the re-ask command. `--pin-from` is the re-ask: it pins each planned file to its blob at the ref (`null` where the ref lacks it) and refuses a block that still gives content inline. Both stay local and read-only.
- 1e603c4: Pin the guide's reconciler health values, `reconciler.no-bot` reasons and `reconciler.cost` fields to the code that emits them.
- b4a8fad: Add the reconciler's observe step (TP-3429): a backstop snapshot and the repo's cursor become event-log appends for every ingress kind plus `RulesChanged`, keyed like the webhook rows so the two dedupe. Only a head or main tip the injected guard confirms emits, and the main cursor is held below a commit whose checks still run.
- 4304fa4: Run the GitHub reconciler on the effective sources mode's cadence: a 15 s due-check tick passes every `github.pollingIntervalMs` under polling and every `github.backstopIntervalMs` under webhook, and a kill-switch flip logs one line and runs a catch-up pass on the next tick. `RECONCILER_KINDS` declares what the reconciler can write, and a test diffs it against the ingress table.
- 046b0f3: Add the GitHub backstop reconciler service (TP-3430): every read is a `github-api` pool claim at backstop priority, a refused claim writes nothing and moves no cursor, more than 2 skipped intervals logs `reconciler.starved`, and serve runs a non-blocking forced start pass behind `reconciler.enabled` (off by default). Migration 36 adds the reconciler's cursor table. `reconciler.intervalMs` defaults to 5 minutes and must be 5-10 minutes under `github.sources: webhook`.
- 666c354: A pull request that touches `.github/fix-proof.json` is now held for the adversary reviewer as a policy touch, beside the owner-tap, inbox-actions, gate-resolve and owner-release paths. The file configures the fix-proof gate, so an edit to it can weaken a merge gate.
- a931cc2: Test the visual-packet and diagnosis wiring in `workflows-spawned.ts`. No behaviour change.
- 86b7d68: Shepherd's sent-back gate after a fixer exits a fix-proof wake with no push now offers the owner's `waive-proof`, as the NO_REPRO send-back already did. The option is never recommended, the waiver covers only that head, and the merge stays the owner's. Other wake kinds still offer only `await-new-head` and `abandon` (TP-3986).
- 6fafbcc: Shepherd's test-only register hint and its fix-proof wake brief no longer steer a flaky-test fix into adding a mutation spec. A spec keeps a vacuous proof NO_REPRO even with `noReproProceed` on, so both now tell a test-only flake fix to register `--kind test-only` and leave out any `*.mutations.json` (TP-3987).
- 08e5112: Shepherd holds a pull request `g10-adversary` when it changes a file on the list of files that decide who may resolve a gate. A test traces the resolve sinks with the TypeScript checker (callers, implementers, forwarders and `GateResolver` builders) and fails when a file in that closure is not on the list. Files that build no resolver, such as the owner's skill-diff guard, are listed by hand. Test-only changes stay unheld. The test is a heuristic trigger, not a completeness check. Forms it misses are listed in the Shepherd guide and tracked as tasks.
- 9e9e171: Shepherd's G10 hold folds case when it matches the gate-resolve check unit, so a closure helper renamed only in case still holds.
- f31b16b: Hold an edit to `gate-resolve-sites.test.ts` or its mutation sidecar `g10-adversary`: the closure check for who may resolve a gate is no longer exempt as a test-only change (TP-4065).
- c15f0dc: Add `shepherd.gateReset.noReproProceed` (off by default): a test-only PR whose diff the classifier reads as tests alone goes to review on a vacuous or test-less fix-proof, recorded as unverified `no-repro-test-only`; the reviewer brief names it.
- e66cdab: A held send-back, whose successor agent-chat refused to start, now also messages the wake's findings to the lineage's newest agent (else the registered implementer), which can still push the fix by hand. The wake step records the outcome as `predecessor`.
- 2c20516: Add an inbox withdraw verb and auto-withdraw self-healed alarms (TP-4112). owner-queue gains a `./withdraw` subpath (`withdrawDeposit`, `restoreDeposit`, `withdrawMatching`, `readWithdrawal`): a seat withdraws only its own deposit, with `<id>.withdrawn` beside it and never an answer file, and each withdraw and restore is appended to the spool's `withdrawals.jsonl`. It also gains `alarmKey`, `collapseRepeats` and an optional `repeats` on `OwnerItem`. `titan-console inbox withdraw|restore|withdraw-matching` exposes it (refusal 65, unknown id 66); the inbox lists withdrawn deposits apart from answered ones and collapses open repeats of one alarm into the newest. A verified console update withdraws its earlier update-failure items, and a factory deploy that holds withdraws the open deploy alarms and incidents, both as `resolved`.
- 1a873c7: A replay-diverged shepherd run with a pending owner gate stays parked instead of being restarted, which cancelled the gate and left the new run never asking the owner again (TP-3801). `shepherd.owner-load.waiting_now` now counts each held registration with no pending gate, so it cannot read PASS while an owner gate is missing.
- 1745d34: Land no longer counts a merge step that waited on a hold toward its 20-cycle settle limit, so a PR held for an owner release stays parked instead of failing after about 20 hold checks, a restart included (TP-4082).
- e9623fa: Fold two multi-line literals in `land.ts` so the file fits the 350-line cap again (TP-4229).
- 2380fd4: Walk retired generations in Shepherd's reviewer independence proof (TP-4132). agent-dispatch adds `listAgentLineage`, which reads `agent ls --json --include-retired`, parses each row's `retired` marker, and on an agent-chat that predates the flag falls back to the plain roster marked incomplete. Factory proves independence against that lineage, so the spawner of a seat's retired first generation counts as an ancestor; an incomplete lineage proves nothing. Retired rows feed the proof only: the roster that names, resumes and finds reviewers never includes them.
- e933eb7: Shepherd judges main by the required contexts plus the `mainContexts` listed in `.github/required-checks.json`, so a red main-only check such as a test shard freezes main (TP-4401).
- a20c348: Serve's main CI watch now logs a `main CI watch ALARM` error, at startup and again whenever the set changes, for each seat its own send route can pick (for a run registered now, and for a merge no seat maps to) that no connected agent-chat session holds. A `detached` seat counts as dead, as the send cannot reach it. A roster that cannot be read skips the check with one warning. Before this, a send to a dead seat failed and was retried quietly every sweep, so no seat heard about a red main.
- a20c348: New config key `shepherd.redSeat` (`{ repos?: { "owner/name": seat }, fallback?: seat }`): the main CI watch sends a repo's red-main events to its entry (keys match in any case), else to `fallback`, ahead of the run's seat, the branch-prefix seat and `shepherd.hubSeat`. Only red events read it; merge policy and the seat a run records still come from the seat file. The dead-seat alarm checks the red seat in their place.
- b675037: Merge order: a reservation whose run a person holds (an owner hold, or a g10 or other gating hold no reviewer has satisfied) no longer orders unheld peers while the hold lasts, so it stops blocking them until its TTL. The merge guard, the order wait and `shepherd order` all read the same predicate, and `shepherd order` lists such a reservation as `held`. A merge step that starts waiting behind a reservation now logs one `order-wait` event, which `shepherd timeline` shows, and a merge past its phase limit names the wait in its `shepherd status` stall flag (TP-4133).
- 0f83e8d: TP-3900: a fix-proof `NO_REPRO` send-back no longer records a `FIX_FIRST`, so it spends only the two fix-proof wakes and never reaches `fix-first-runaway`. The third goes to the `sh-sent-back` gate, worded `fix-proof did not reproduce (NO_REPRO)`. D8's convergence review starts only when the trail holds a reviewer `FIX_FIRST` and the head's fix-proof did not say `NO_REPRO`. A run recorded before this change replays its `sh-wake-fix-first` and D8 steps without diverging.
- f15a84e: Add `shepherd.gateReset.nonSourceNoRepro` (`keep-owner` when absent, today's behaviour). With `record-fact`, a fix-proof NO_REPRO on a non-security PR that changes no source goes to review marked unverified `no-repro-non-source`, and no `sh-sent-back` owner gate opens; the merge grant is unchanged. No source means the fix-proof plan, under the trusted configs, sorts no path as source, or the diff is the workflow-only diff a CI proof read. `@titan-design/review-panel` exports `noReproProceedOf`, the one reading of which unverified standings proceed and on what, so the brief rule, the tests member question and the panel plan all follow it. The row is live-editable (TP-4275).
- cadc05b: The reconciler has one cadence knob: `github.backstopIntervalMs` under webhook and `github.pollingIntervalMs` under polling. `reconciler.intervalMs`, which nothing read, is deprecated: the load still accepts any number there for one release, so a config that sets it keeps starting, and serve logs `config.deprecated reconciler.intervalMs ignored; use github.backstopIntervalMs` at start. The cross-field check that bounded it to 5-10 minutes under `github.sources: webhook` is gone, since `github.backstopIntervalMs` already carries that bound.
- c4eeb28: Add the `sh-review-scope` probe step (TP-3735 S1): for a fix-round head it diffs the reviewed head merged with the base against the head, so main's changes drop out, and answers scoped (paths, head-side hunks, changed lines) or full on a rebase, conflict, over 400 lines, over 40 paths, a shell-active path or any git failure. Registered but not yet dispatched.
- 81c0a9d: Shepherd's console Ship sweep now matches a round's repo to a gate's repo case-insensitively, so a round that names `Owner/Repo` resolves the approve-merge gate whose prompt says `owner/repo`.
- 033c710: Wire the scoped fix-round re-review behind `shepherd.review.scopedRereview` (TP-3735 S3), off when absent. Under `shadow` or `on`, a fix round after a reviewer's FIX_FIRST runs `sh-review-scope:<head>` and records `scoped` (and why not) on the `sh-review` result; under `on` the correctness brief reads the fix diff and the findings since the run's last MERGE. The first review, other causes, D8's convergence head and every other panel member stay full.
- e462073: `CliDeps` no longer takes a `presence` check and `FactoryServerOptions` no longer takes an `ownerKeys` loader, so no composition root can swap the checks that decide who the owner is. `gate resolve` and `shepherd owner-release` always ask `confirmOwner`, and serve always reads the key ring through `loadOwnerKeys`. Tests reach both through their OS edge only: the helper runner, lstat and helper path, and a key directory on disk, set from `test-support/owner-edges.ts`. Behaviour is unchanged.
- ff6fb95: `distinctRequests` and the `TranscriptRequest` type move into session-read, next to the transcript readers; factory's step-usage and autoresearch import them from there instead of from autoresearch internals.
- e220057: Shepherd merges main up for a ci-red head whose red came with a stale merge ref (TP-4650). When the base commit the head's CI ran against has no finished run of a failing check, as when a newer push cancelled it, the base-red decision walks back to the base's last finished run of each one. If each of those failed at the same step with the same failures as the head, and a later base commit is green on them and on every required context, the head is held as a stale base red and update-branch merges main up, with no fixer woken and no repair spent. A cancelled or missing run is never read as the base's red. One run makes at most two such merge-ups before it wakes the fixer, so a busy base cannot merge up a head that stays red forever. The run's own hold and the await-new-head hook read that limit from the same decision, so once it is spent the hook no longer ends the fixer's wait on a main-fixed red.
- 65e43e5: Shepherd's ci-red waits for a new head now re-run the base-red hold decision while the head is unchanged. `ciFailedRoute`, `afterFixerExit`, `afterHeldWake` and `repairGate` pass the failing check names into `await-new-head`, and serve wires the new `inheritedRedCheck` into land-pr's wait. The check reads the base head on each due tick and decides again only when the base moved or 30 minutes passed. Once every failing check is the base's red, a stale base's or a frozen main's, the wait ends `baseRed`. The next round's hold then merges the head up for fresh CI, with no implementer push and no repair spent. A head with a failure of its own still waits for a new head.
- eb36381: Shepherd's 5-minute gone sweep clears a `main-ci-timeout` gate once the base branch's tip contains the merge sha and is green on every required context, recording that evidence on the run. The gate stays open while main is red, still running or off the merge's line (TP-4319).
- a4509a8: Shepherd: each registry command now declares its in-process access (`read`, `write`, or `list-or-write`) in `shepherd/port-access.ts`, and the agent-env in-process refusal is computed from it instead of a hand-kept name list (TP-4281). The refused set is unchanged; a command added without a declaration fails typecheck and a test.
- 3cac514: Shepherd classifies a red that ran on a base the PR left, or on a branch that no longer exists, as a stale base and wakes the implementer for a merge-main head instead of a ci-red fix.
- f31099c: A `main-red-again` or `main-frozen` gate on a merged PR no longer stays open after its freeze episode thaws. The gone sweep (every 5 minutes and on each thaw) and `shepherd resync` cancel the gate once the episode it asked about is no longer live. Each cancel writes a `gate-cancel` shepherd_event row naming the run, which takes a table-rebuild migration (39). The run reads the cancel as its answer and goes on to cleanup without thawing anything. A gate cancelled for any other reason still fails the run, as before. `resync` reports these cancels as `closedMainGates`.
- 97aedab: The deploy pacer now says why it holds a deploy. Each sweep that decides to wait logs `deploy pacer: waiting for <sha>: <why> until <time>`, but only when the wanted sha or the reason changes, so a standing wait logs once and a busy-run count that moves logs nothing new. `/health` `deployPending` carries the current wait as `waiting: { why, until }`, and `titan-factory service check` adds `; deploy <sha> waits: <why> until <time>` to its line, with `deployWaitSha`, `deployWaitWhy` and `deployWaitUntil` in `--json` `detail`.
- d14d760: Pin that an unverified fix-proof reaches the reviewer as explicit text, never as silence. A fix-proof read that errors now has a review-phase test showing the `unread` standing and the FIX_FIRST rule in the correctness reviewer's brief. Under the review panel, every member's brief must carry them too, and a new mutation in the sidecar drops the standing from the members' shared input. The untrusted and error-verdict tests now also assert the FIX_FIRST rule, and the missing and skipped reads assert the brief stays silent. Test only; no production code changes.
- a2da8ac: `formatSquashMessage` defangs CI skip tokens (TP-2653). The five bracketed skip forms GitHub documents (skip ci, ci skip, no ci, skip actions, actions skip), in any case or inner spacing, have their square brackets turned into parentheses, and a skip-checks trailer set to true loses its colon, in the subject and the whole body, code included, so a squash merge can no longer skip main CI and Release. Re-formatting the output still changes nothing. The rewrite is exported as `defangCiSkip`, and the factory's squash fallback (plain title when formatting throws) applies it to the title.
- 57a117f: Shepherd's run policy now carries a seat's `visual_baselines`, so a visual head that changes no baseline merges on its green baseline check instead of always gating on the owner (TP-2662). A repeat registration keeps baselines only when both policies carry the same ones. A vitest type test (`.test-d.ts`) under a visual glob no longer counts as rendering.
- 6525ba7: The verdict parser no longer reads a line naming a ci-policy identifier (`ci-policy-changes.ts`, `ciPolicyAt`) as a CI-policy line, so such a review parses MERGE; a weakened reading still fails closed wherever it sits. Shepherd's correction now quotes the blamed line, and the failed-round list and ops notice name a correction that did not parse `malformed`, not `timeout` (TP-3237).
- 696e384: `shepherd register` now revives a cancelled run whose pull request is open again (TP-3731). Shepherd cancels a run only when its PR read merged, closed or gone, so a repeat register starts a new run at the PR's current head, as it does for a failed run, and the registration keeps its holds (an owner-asked hold included), kind and authors. A cancelled run whose PR is closed still comes back unchanged.
- 7d3b5fb: Check a scoped fix round's FIX_FIRST behind `shepherd.review.scopeCheck` (TP-3735 S5), off when absent. `sh-scope-check:<head>` counts blocking items outside the fix's ranges with no `Important:` and `Class:` line, and items that restate an open finding. `shadow` records the counts; `on` asks the reviewer for one correction and keeps a second miss as written. Review stats store the counts, report them per week, and count a `scopeShadow` round as full.
- 481f3e4: The panel aggregate counts a vacuous fix-proof that `provedByMutants` proves as good, as Shepherd's fix-proof judge already did, so it no longer adds an unplanned blocking tests seat that left every round `no-verdict`. `PanelVerdict` gains `fixProofShortfall`, set when that unplanned tests seat is the only blocking member missing; when that proof is vacuous or test-less, Shepherd sends the head back as its own NO_REPRO instead of retrying a fresh reviewer, and an owner's waiver of it now clears the seat on a test-only head that proceeds.
- df05763: Shepherd's G10 release counts a non-strict stale-green CI read (`behind` with `baseMoved` and the head's own checks green) as green, as land merges that head as it stands. Before, a two-MERGE `g10-adversary` hold, or a `g10-review` hold, on a base whose land rules are not strict never released once main moved past the head's green (TP-3933).
- 55de74f: Shepherd's post-merge redeploy now queues the green main commit that sh-main-ci read, not the merge sha, when the merge's own main run was cancelled and a newer push answered for it. Before, a burst of merges acknowledged on one green tip queued in the same second, and the oldest merge sha overwrote the tip in the deploy pacer's record: the pacer then deployed that older commit, or cleared it because the running build already held it, and the tip waited for a manual deploy. The step id is unchanged; the input gains an optional `greenSha`.
- 661a027: Shepherd's `testOnlyDiff` reads a PR that changes only a mutation spec as test-only when the spec's sibling test exists at the head (TP-4039). It probes each spec's sibling by test extension, since GitHub lists no directory, and passes what it finds to the fix-proof plan, so Shepherd and the CI plan agree. A spec with no readable sibling stays flagged as adding no test.
- 801f9c4: A test-only head that proceeds on its vacuous fix-proof no longer dead-ends under the review panel (TP-4058). Shepherd plans a fresh, blocking tests member for it, right after a g10-adversary hold's member, instead of leaving aggregate's unplanned tests seat empty and sending the head back as the proof's NO_REPRO. The tests member's brief asks, for each changed test, whether it would fail without the change it covers. Its MERGE lets the panel merge with no waiver; its silence is still no verdict, and its FIX_FIRST goes to the fixer. A diff that also changes source still ends as NO_REPRO, and an intent recorded before this change keeps the old NO_REPRO.
- 573d7a5: The deploy pacer no longer clears an asked deploy while the build that contains it is still in its health watch. It waits until deploy.json records that build and the window in deploy-window.json has closed, or until 30 minutes after the window if the deployer died without recording anything. When that containing deploy rolls back, the pacer asks the deployer once for origin/main after the pause is cleared. A newer main deploys; a main that is still the rolled-back sha is held, and the ask is dropped after the stale timeout. Before, the ask was cleared mid-watch, so a rollback left nothing to redeploy until the next merge.
- 6bf4462: `shepherd status` now shows a post-merge run in `sh-cleanup` as "cleaning up after the merge: head branch, task and agents". Before, every post-merge step was shown as "watching main CI after the merge", so a run that had already read main CI as green and queued its redeploy looked stuck on main CI while cleanup waited for agents to exit.
- 95a853b: An approve-merge gate whose prompt carries the reviewer's owner brief or a skill-diff line below its policy line now reads as a land gate, so a coordinator's mechanical merge, merge-at-head, gate batches and console taps act on it. Land now writes a marker line on the gate naming each D21 fact that holds at the head, whatever the gate's rule: a skill change, a CI policy the reviewer judged weakened or wrote malformed, or changed files nobody read. Shepherd reports these facts from the MERGE evidence. A marked gate stays off the console tap, merge-at-head, standing answers, Ship answers and batches, and an earlier approval never follows to it. So does a multi-line gate opened before markers existed.
- c941ed9: Add the pure snapshot measure for Shepherd's visual-diff threshold: `snapshotShare` decodes a base and a head PNG and returns the pixelmatch share of changed pixels within the content box (1 when the sizes differ, antialiased pixels ignored), `contentBox` bounds the pixels that differ from the corner colour, and `componentOf` names the component a story or specimen snapshot shows. Adds `pngjs` and `pixelmatch`. Nothing reads it yet.
- c3b7ad6: Shepherd now replaces a live implementer that starts no turn after a wake and its message fallback. It retires the agent, never forced, and starts a successor in successor mode with the same failure context, through the existing spawn gate. The seat is told only when the successor also starts no turn, when agent-chat refuses the retire (a tree with unpushed work), or when no successor could start (an advisory repo or one with no checkout).
- ceaec0c: The restart drain and the deploy pacer no longer count a run as busy when its `sh-review` step is a spawn the spawn gate deferred and has not admitted. No reviewer was started for it, and the step repeats after the restart, so a loaded machine can no longer hold a deploy indefinitely. A run spawning or running its reviewer still counts as busy, as does an in-flight step that does not spawn. `busyRuns` takes an optional queue predicate, `factoryHealth` takes one as its last argument, and serve wires both from the new `gateQueuedRun`.
- e0ef84f: The route wiring's visual-packet and diagnosis ports moved to their own module, which brings `workflows.ts` back under the 350-line cap. Behavior is unchanged.
- a37b686: Wait only on runs busy when a restart drain began, so steps admitted during the drain cannot stretch it. A busy park-routed step still holds the restart.
- d4ad311: Use the shared narrowing helpers from `@titan-design/rpc-protocol/narrow` in place of local copies. Behaviour is unchanged.
- 114dceb: Shepherd now awaits a descendant main tip whose required runs are not reported yet, so a held red no longer freezes main while that tip's CI is still queued after a serve restart (TP-4653).
- ed4c3ac: Burn down typed-lint hits outside Shepherd (TP-2176): read parsed JSON, YAML, `/health` bodies and caught errors through checked narrowing in place of casts.
- dbd049e: Burn down typed-lint hits in Shepherd's source (TP-2176): stored evidence, step outputs and caught errors go through checked narrowing in place of casts, with the merge evidence guard's predicate unchanged.
- 962b334: Burn down typed-lint hits in Shepherd's tests (TP-2176): test fakes use `partialFake` and `fakeLocator`, and malformed-input probes set their bad field with `Object.assign`, in place of casts.
- 8529601: The service unit renderer takes its systemd escaping, PATH-list, node-path and XDG unit-directory helpers from `@titan-design/daemon/service` instead of its own copies (TP-2473 b). Rendered plists and units are byte-identical.
- 51ee4c4: Add `@titan-design/png-delta`: the bounded PNG decoder and pixelmatch share moved out of the factory's shepherd, plus
  `pixelDelta` and `encodePng`. The factory now reads its visual-delta measure from the package, and the console's Ship
  Diff tab shows a base-vs-head delta image with its changed-pixel share for each changed frame (TP-2512).
- 0e6b4b9: Shepherd's registration hold hands review-panel each renamed file with its `previousPath` instead of adding the old path as a file of its own, now that the panel matches a rename's old path (TP-2698).
- 6cf8254: Serve now removes a post-merge chore's marker, spec and result files once the `post-merge` step has a recorded result, on the step's `step_complete` event and on host bind for sets a crash left behind; files of a step with no recorded result stay for `reconcilePostMerge`. `FactoryRoutes` gains an `onEvent` hook, `composeRoutes` merges two bundles' `bindHost` and `onEvent` (a throwing hook is logged and never stops the other), and `withAutoresearch` composes with routes that already bind a host instead of throwing.
- a645c42: Shepherd's sh-unfreeze re-reads the freeze before it reports the repo still frozen, so a thaw elsewhere during its GitHub reads no longer opens a main-frozen gate after the thaw sweep has already run.
- d9f8d32: With `shepherd.gateReset.noReproProceed` on, a `correctness` PR whose diff the classifier reads as tests, mutation specs and changesets alone now goes to review on a vacuous fix-proof as `no-repro-test-only`, as a `test-only` one does, rather than gating on an owner waiver. Security runs, diffs that touch source, and lines carrying mutants keep their NO_REPRO.
- 2ff7b35: The event log can derive `CIConcluded` occurrence keys for check runs and statuses from a webhook delivery or a GraphQL backstop node, so one occurrence from both sources stores one row (TP-3390, TP-3095 S2). Nothing reads or emits them yet.
- 833e4e2: The event log can derive occurrence keys for `PRMerged`, `PRClosed`, `ReviewSubmitted`, `ReviewDismissed` and `RulesChanged`, and transition observations for `HeadPushed`, `BaseChanged` and `MainMoved`, from a webhook delivery or the GraphQL backstop's shape (TP-3391, TP-3095 S3). Nothing reads or emits them yet.
- 6bb608c: Every green merge on the factory repo now queues a redeploy, including merges outside Shepherd's land step (seat-merge, bin/merge, an owner merge). serve's main CI watch writes `deploy-wanted.json` through the same queue Shepherd's redeploy step uses, so a newer queued sha is kept over an older merge it contains. The watch covers the factory repo even when no seat lists it. The `/health` deploy block now also counts the running build's lag behind main from git while no deploy is queued. It fetches main into a private ref, `refs/titan-factory/watched-main`, so a merge no one deployed raises the alarm instead of reading `behind: 0`. `shepherd status --deploy` no longer counts serve's own reading twice (TP-3474).
- 3ca4fc1: Land trusts an approved-set answer for its own head only: a refresh or update-branch that follows it in the same round asks again instead of inheriting human trust.
- 472877c: Shepherd carries a reviewed MERGE across a merge-up whose first parent is an unreviewed merge-up when the PR's own diff is unchanged (TP-3725). The tree probe records `patchEqual`, a patch-id comparison of the new head's diff against its second parent with the reviewed head's diff against its merge base, and the carry scope records `g10Held`. Only `correctness`, `feature` and `refactor` runs never G10-held take the rule; security runs and G10-held runs re-review as before, and the carry records no `sh-merge-up` step.
- d0485c4: Shepherd no longer asks the owner about a failed fallback reviewer or a surviving conflict (TP-3734 r3). A fallback reviewer that fails on infrastructure too records `D7/ops-notice` and tells the hub seat, naming the failed outcomes and the reviewer account; a seat-held run-out tells the seat (`D7/seat-notice`). A conflict that survives the implementer's fixer wakes one fresh fixer, then tells the seat. Each run then waits for a new head. `GATE_DEMOTIONS.failedFallback` and `GATE_DEMOTIONS.conflict` revert each one.
- 095a6e2: Shepherd no longer opens approve-merge when MRG-AU-RV fails on `repo-not-frozen` alone: land waits at the head, re-reading the merge facts, and merges after the thaw with no gate or notice. A `no-facts` merge-guard gate re-reads once at the head, then sends the seat one notice (the owner gate opens only when no notice could be sent). Both sit behind `WAIT_DEMOTIONS` in `freeze-wait.ts` (TP-3734 r3b).
- 6de2efe: Shepherd no longer asks the owner to merge a head with no reviewer MERGE (TP-3734 r4). Such an approve-merge gate does not open: the head gets one fresh reviewer (`R4/fresh-reviewer`), then the repo's seat hears and the run waits for a new head; the gate opens only when that notice cannot go out, saying why. D7 and D8 route escalations keep their own paths. The approve-merge brief no longer claims no reviewer said MERGE when a panel member did. `GATE_DEMOTIONS.noMergeNoAsk` reverts it.
- 54e2649: Shepherd sends failed review rounds that never got an adversary verdict to a diagnosis planner (TP-3796). When every counted round failed on infrastructure and no adversary returned a verdict (a refused adversary spawn counts as none), Shepherd starts no fourth blind review and opens no owner gate. It records `D7/no-verdict-diagnosis` and spawns one planner at `shepherd.diagnosisProfile` (default `bd-planner`, passed to agent-chat as configured). The planner's brief carries the PR, the head, each silent reviewer's session id and transcript path (or "never started" with the refusal), and the `serve.err.log` lines that name them. The run then waits for a new head. A planner that cannot start falls back to the D7 ops notice. D7's fallback reviewer still applies when an adversary ran and returned a verdict. `GATE_DEMOTIONS.neverVerdictDiagnosis` (default on) reverts it.
- 8fc0cb8: A console Ship at a PR's exact head now answers a Shepherd merge-guard visual-path gate (TP-3797); other merge-guard kinds stay pending.
- 19edd80: Adds the webhook ingress core (TP-3802, TP-3100 S1): `answerDelivery` verifies `X-Hub-Signature-256` over the raw body, answers 404 before reading the body or the secret unless the effective GitHub sources mode is webhook, and appends at most one `source='webhook'` row keyed `webhook:<delivery>`. Nothing binds a port or calls it yet.
- d679432: Adds the webhook ingress listener on serve (TP-3830, TP-3100 S3): a second loopback listener on 127.0.0.1:7411 that answers only `POST /ingress/github` through `answerDelivery` and `projectDelivery`. It reads the kill switch on each request, so a config edit to `sources: webhook, ingress: on` applies to the next delivery with no restart. It reads the webhook secret file lazily and re-reads it on change, and it cuts a stalled sender at the request timeout. A bind failure is logged once and shown in `health.ingress`, and serve keeps running.
- 478651d: Shepherd's conflict wake brief tells every fixer to merge the base branch from origin and push plainly, never to rebase or force-push.
- 12afa80: A g10-adversary hold's adversary member is uncapped, so an opus correctness member no longer lowers an opus-class hold member to an uninstalled `reviewer`. Shepherd's panel plan now asks whether each lowered profile is installed headless, and refuses the plan, naming the profile, instead of dispatching a member that can only be refused (TP-3907).
- 8e826eb: Shepherd stops retrying a no-verdict panel round that repeats the last one at the same head (TP-3910). When round 2 at an unchanged head records the same panel outcome with the same seats missing, and no member of either round failed to start or waited out its deadline, Shepherd dispatches no further reviewer. It takes the TP-3796 path instead: it records `D7/no-verdict-diagnosis` and spawns the diagnosis planner, then waits for a new head. The rounds are compared from the recorded `sh-review-panel` outcome and each member's dispatch and await steps; no transcript is read. A seat that no member was dispatched to fill, such as the unplanned tests seat, compares as `unplanned`. A round where a member failed to start or timed out, or whose missing seats differ, is still retried as before. A run recorded before this change that reviewed the repeated head again replays that review. `GATE_DEMOTIONS.neverVerdictDiagnosis` turns off both diagnosis routes.
- 32637bd: `proofStanding(read, head)` in fix-proof is the one reading of a fix-proof read at a head: `proved`, `no-repro` (with `proceeds` for a test-only or non-source NO_REPRO the caller lets through), `unverified`, `unproven` or `none`. `endsReview` and `needsTestsSeat` answer the two questions callers ask of it, and `FixProofUnverified` moves here. Shepherd's gate and waiver and review-panel's `fixProofNeedsTests` now derive from it instead of parsing the line each in their own way; no behavior changes, and `unproven` still lets the review run while making the tests seat blocking. review-panel re-exports `FixProofUnverified` unchanged. review-workflow's `ProofRead` is now fix-proof's `ProofReadInput` (TP-3923).
- 41b7ab5: `shepherd.review.workflow: on:preflight` is live (TP-3928). Before any reviewer starts, the review intent refuses a head whose panel would dispatch a member planned onto, or lowered to, an uninstalled profile. The intent records the fixer fingerprint, the run is held through the no-reviewer hold, and the round ends `needs-fixer`. The new `await-fixer` route reviews the head again after the hold's wait and counts no failed round. `carried` joins the review outcomes on the merge path. A `shepherd.review.adversaryProfile` that is not installed headless, or whose lowered profile is not, now fails the config load. `shadow` and `off` are unchanged.
- dc1c43d: A Shepherd merge waiting on a `g10-review` or `g10-adversary` hold now asks the `sh-g10-release` step again once after a restart, when the newest ask at that head was a recorded no. Before, a replayed no stood for good: a deploy that fixed the release rule (TP-3933) never freed a run already waiting at merge. The wait ends with no merge, land reads CI again, and the run asks the release under the code now serving, with every check of the rule kept. A no from that live ask is not asked again until the next restart.
- 094f919: Seat notices and exit notices reach only a seat with a live session: a retired seat's notice goes to the repo's
  `shepherd.redSeat` entry, the red seat fallback or `shepherd.hubSeat`, whichever is live first, and the step's detail
  names it. A non-fixer registrant receives a run's notices and digest only while live, else the repo's seat (TP-3958).
- 9a58ebd: Shepherd's fix-round successors now follow the review account rotation (TP-3961). A successor spawns under the first account with headroom in the account-limit store: `shepherd.fixer.configDir` (or `shepherd.review.configDir` when unset), then `shepherd.review.fallbackConfigDirs`. Before, it always took agent-chat's default account, even while that account was out of usage. When every account is exhausted, or the store cannot be read, a successor still spawns under the first account.
- 1c38962: A red main's fixer now picks its account the way fix-round successors do (TP-3962). Before, it always spawned under `shepherd.fixer.configDir`. Now it takes the first account with headroom from `shepherd.fixer.configDir` (or `shepherd.review.configDir`), then `shepherd.review.fallbackConfigDirs`. A woken fixer or successor whose session ends on Claude Code's usage-limit notice now marks its account exhausted in the account-limit store, as a reviewer's does, so the next successor spawns on another account.
- 094f919: A fixer wake whose lineage the agent-chat roster no longer shows starts a successor in the repo's checkout, taking over
  from the registered implementer, instead of ending unhandled and opening `sh-sent-back` (TP-4045).
- a6f1773: The seat digest reaches only a seat with a live session, by the same routing as seat notices: a retired seat's digest
  goes to the repo's `shepherd.redSeat` entry, the red seat fallback or `shepherd.hubSeat`, whichever is live first. With
  none live, no digest is sent and serve logs why; an unreadable roster keeps the seat (TP-4050).
- 321f282: A seat digest rerouted from a seat with no live session no longer replays that seat's whole backlog. It lists finished runs only since the seat's last digest, never more than 24 h back. Older rows are settled, so a later sweep neither sends nor reads them. A digest to a live seat is unchanged. Seat memory now records when each seat was last sent a digest.
- ab9826d: When a run's registrant is no longer live, its seat digest now goes to the first live seat up the registrant's spawned-by chain. That chain is read from the agent-chat roster. Only when no seat in the chain is live does the digest fall back to the repo's seat and, after it, the red seat, red seat fallback and hub seat, as before. That digest counts as the owner's, so the 24 h reroute window does not apply. When the roster can't be read, digests go by repo seat as before, and the sweep now logs why.
- fb1c4f4: `titan-factory gate resolve` from an agent-chat shell now proves the owner's presence with a record the gate store checks, not a bare UUID (TP-4066). The CLI asks the owner's Secure Enclave key to sign a `titan-factory.gate-presence` statement for exactly that gate and answer (the same Touch ID dialog), verifies it against the root-owned owner key ring, and records it in the gate batch ledger. The resolver's `confirmEvent` names that record (`gate-batch:<id>`). The gate store's `authorize` refuses a `factory-cli` confirmEvent that names no record, a record for another gate, a spent record, or a record whose stored signature does not verify against the owner's keys, and spends the record when it admits it. The owner's own terminal (no agent marker) is unchanged. An agent-chat shell now also needs the owner key in `/etc/titan-factory/owner-keys`, as the remote resolve-proof route already does.
- bf7589d: A workflow-only PR whose fix-proof says NO_REPRO now goes straight to the owner's waivable `sh-sent-back` gate instead of waking a fixer. Its CI proof needs a required check red at the merge base, which no push to the PR can make, so the wake always ended at that gate (tp#2325). A run recorded before this replays its fixer wake as it ran. The send-back route moves from `pr.ts` to `shepherd/send-back.ts`.
- a037364: Reviewer-independence lineage reads a roster row whose spawner is its own name, as each teleport generation of a seat
  records, as the same seat rather than a loop, so a reviewer spawned by a teleported seat can be proven independent. A
  loop through other names and a row with no stored lineage are still refused (TP-4130).
- cb470f4: Carry `predecessor` from `agent-chat agent ls --json` through to Shepherd's roster. `AgentRow` gains an optional
  `predecessor`: a string or null passes through, a missing or mistyped key stays absent and is never read as null. The
  reviewer roster maps it the same way, so lineage can prove a reviewer independent once agent-chat reports the field,
  and a roster without it still proves nothing.
- 48313fc: `planner wake` now waits for the planner's review: it polls the new `reviewDir` until a `*.md` newer than the spawn appears, and files an owner-inbox alarm (with the transcript's last API error) when the planner exits without one or after `noFileAfterMinutes` (default 30), exiting 1. The next wake that sees a review withdraws the alarm. A `configDir` under `.claude-profiles/personal` is refused.
- f3d679b: Name the merge-order reservation a merging run waits behind in `shepherd timeline` and `shepherd status`: the row's `orderWait` gives the holder's PR, its run's phase and the reservation's since, and `nextAction` and the stall flag say the same (TP-4137).
- 7810ad0: `shepherd owner-release` from an agent-chat shell no longer takes the presence helper's bare proof UUID. The owner now signs a `titan-factory.hold-release` statement for the run, PR, head and owner-asked hold, and the factory records it in the gate batch ledger. Before it lifts anything, `ownerRelease` re-verifies that record against the owner key ring and the live hold, then spends it. A bare or unknown confirmEvent, a record signed by a key outside the ring, and a statement for another PR, head or hold (including a re-placed hold with the same text) are refused with exit 77. A presence helper without a signing key can no longer release from an agent-chat shell.
- 3fb82f4: The factory's `shepherd` /events frames now carry an optional `workflow` ("autoresearch" or "shepherd") derived from the run's workflow, so the console refetches autoresearch reads only for autoresearch runs. Additive: a frame without it means the same as before.
- e1c4ce1: Retry the no-verdict diagnosis planner after a spawn gate deferral (TP-4157). A deferred spawn is asked again a window later, up to 5 asks, and each gate reason is recorded in the step's `deferrals`. Before this, one rate-window refusal sent the ops notice and left the run waiting for a new head with no planner.
- 6d79a8b: Add `promptLine` and `PROMPT_LINE_BREAK` to `@titan-design/owner-queue`: one cleaner for author- or agent-written text bound for an owner prompt, which drops ANSI escape sequences, C0 and C1 controls and every format character (bidi overrides and isolates, zero-width and tag characters) and flattens CR, LF, NEL, U+2028 and U+2029. The D21 ci-policy card, the console's decisions-file line and the Shepherd wake brief's review comments now all use it, so the decisions line also drops bidi and escape sequences, the wake brief strips them from comment paths and bodies (a verdict line behind a bidi override is now quoted), and the ci-policy card also drops tag characters and soft hyphens.
- f2bada0: On a `ci-policy-weakened` gate, the merge evidence step now reads each changed `.github/` file (the first 10) at the base and the head, and stores every changed line of a positional diff on the evidence record as `ciPolicyChanges`. No line is chosen by what it says. Each line is either shown or counted in `omitted`: 20 per file, 120 per card, 160 characters per line. Lines split at CR, LF and CRLF only. NEL and U+2028/U+2029 become a visible mark, and escape, control, bidi and zero-width characters are stripped. A failed read is named in the gate's reason; the gate itself does not change.
- 8cae073: Show the D21 owner card on a ci-policy-weakened approve-merge gate: the class and keys, then every changed `.github/` line at the gate's head (`- L<n>:` / `+ L<n>:`) or its count, with the diff link last.
- 852d2a9: `fixProofNeedsTests` is exported: the predicate `aggregate` uses to make the tests seat blocking. Shepherd's review intent plans a blocking tests member whenever it holds, so an `unproven` or `error` fix-proof on a panel with no tests member is reviewed by one instead of ending every round as no-verdict (TP-4195). A panel that still meets the unplanned seat (an intent recorded before this change) says so in its no-verdict reason, and the diagnosis brief no longer claims no reviewer was dispatched when every one answered.
- 70ef553: Shepherd no longer freezes a repo on a stale or cancelled main red (TP-4230). Before a red that stood its full wait freezes the repo, Shepherd reads the base tip and the default branch's recent commits for one that is or contains the red sha and is green on every required context; if it finds one, the red is read as stale and acknowledged on that commit, so no episode opens and no fix task is filed. A failed read keeps the red. A failed read made of cancelled runs plus required jobs skipped behind them now reads as a cancel, which waits, and never as red; main-watch reads it the same way. A freeze now names the sha the red was read at, so a merge whose own run concurrency cancelled is never frozen as red.
- 2adc454: A stacked PR whose fix-proof was bound to its parent branch no longer merges into main on that read after GitHub retargets it with the same head (TP-4259). Every fix-proof read that gets a binding now records the base it looked for (`boundBase`), whatever its trust, and the MERGE records it as `proofBase`. Shepherd's merge guard fires only when `proofBase` names another base than the one being decided; a record with none (a kind that needs no proof, a read that got no binding) is governed by owner decision 303 as before, and 303 is unchanged for every PR on its own base. When the guard fires, land reads the head's fix-proof again on the decided base through the review's own `sh-fix-proof` read (step `sh-fix-proof:<head>@<base>`) before deciding. It merges once a line or CI read names that base, whose trust is judged by 303; a skipped read, a missing run looked for there, or the owner's waiver also clear it. The one new owner gate is a re-read after a retarget that names no run on the new base, or another base's, or reads NO_REPRO. A fix-proof run binds only through a line naming the base it judged. Off the decided base, an allow or a mechanical MRG-AU gate becomes a `shepherd-merge-guard/no-facts` gate; any other gate keeps its own rule, with the off-base proof named first. A registration store, registration or head branch that cannot be read makes the fix-proof read an `error`, not `skipped`. A skipped fix-proof judge never counts as a run. fix-proof.yml also runs on an `edited` event that changes the base, so the retarget starts a run on main; any other edit skips every job in a concurrency group of its own.
- d2cce6c: Give the fix-proof result line a `refused` verdict for a PR whose base is not the default branch (TP-4259). A refused line names the PR's `base` and the `defaultBranch` in fields of their own, with no count and no test, so no reader parses a message to find a refusal. Every judged line may also carry the `base` it judged; `fix-proof judge` takes it as `--base-ref`, and `fix-proof-run.sh` passes it from the workflow's `BASE_REF`. A reader that predates either field rejects the line, so it fails closed.

  The review panel counts a refused line as a bad fix-proof, as it did the error line that carried the refusal before.

  Shepherd's fix-proof read binds a run to the PR only when GitHub lists it on the PR's base and its line, if it names a base, names that same base. A run GitHub lists on main after a retarget, whose line judged the stacked parent, no longer counts as a second run on main. A job log that cannot be read is read again on the next poll and is an error at the deadline. A run's distrust is settled before its verdict is read. A refused line's standing is `refused`, and the MERGE evidence records the base the line judged as `proofBase`.

- 9c42d8b: Shepherd no longer freezes a repo or spawns a fixer for a main red whose fix already merged with its run still in progress (TP-4273). When a red stands its full wait and no green commit contains it, Shepherd reads the base tip: if the tip is a later commit containing the red sha and its required runs are still going with none failed, the red is held as awaiting that run. Its green acknowledges the red and clears it; its red lets the red stand on the next poll and opens the normal episode. The hold shares the main-CI read's re-check budget, so a tip that never settles still freezes. A tip whose runs cannot be read, or a repo with no readable required contexts, keeps the red as before. The `sh-main-ci` result records the held-for commit as `awaitedSha`. The fix PR need not be marked by hand for this window.
- 6a2d7df: The deploy pacer deploys only a sha whose own ci.yml push run on main concluded success when it decides (TP-4279). An ask whose run is in progress, cancelled or skipped falls back to the newest older green sha, and a GitHub read that fails holds the deploy. `service deploy --expect` now builds exactly the asked sha: it no longer widens a skip to origin/main or turns a past-ask after a rollback into an origin/main deploy, and the pacer no longer re-asks for origin/main after a rollback.
- b41b3a0: Shepherd's wakes to a live agent now carry `source: shepherd`, so the broker labels them as Shepherd wakes instead of the owner's words.
- ca45ebd: The Shepherd evidence comment gains a Visual diff section when `shepherd.visualThreshold` measured the head (TP-4320 S5). It states the mode, threshold, pixel tolerance and merge base, then a table of snapshots grouped by component with each change and whether it is over the threshold, then the public API, token and harness paths. Removed and unmeasured snapshots read as failing closed. In shadow mode a line says whether `on` would clear the head or what it would gate on. A malformed stored delta reads as unmeasured. The shepherd guide documents the key's modes, metric, rules, caps and coverage gap. The merge decision is unchanged.
- b99e3b5: Add `titan-factory shepherd visual-delta --repo R --pr N [--head SHA]` (TP-4320 S6), a read-only calibration read. It measures the PR's visual delta under the repo's `shepherd.visualThreshold` in any mode, as the merge evidence step would, and prints JSON: the stored `visualDelta` record plus `unsupportedFormat`, the count of shots the bounded decoder refused as `unsupported PNG format`. It runs no step, posts no comment and stores no record. It is declared a read, so with no serve answering it runs in-process, in an agent shell too, and it is also the `shepherd__visual-delta` MCP tool. A repo with no key exits 66. Config defaults are unchanged.
- 780cef3: `titan-factory serve` picks up an edit to its config file without a restart (TP-4351). Each read through the config ref checks the file's inode, size and mtime, and re-parses only when they change. If the edited file fails to load, serve keeps the last good config and logs one warning until the file changes again. Live keys such as `shepherd.visualThreshold` and the `shepherd.gateReset` modes now take effect at the next read inside a running serve. Restart-class keys still keep their startup values.
- f55c6bb: The planning lint warns when a slice grows agent-chat `src` old path (TP-4397 F2). A slice with `repo` agent-chat whose owns fall under a sunset-manifest area the fold deletes gets one warning naming the fold task, unless it sets the new optional `carveOut` field. Surviving areas such as `src/broker` stay quiet. The warning never fails the lint, and the old paths are read from the sunset manifest.
- c6a2ffa: The sunset manifest now covers all of agent-chat `src` (TP-4397 F1). Each area carries a default naming its fold task (TP-626, TP-646, TP-647) or marking it as surviving as product. Manifest entries accept a `TP-<n>` fold id with the `fold` milestone, and a file is reported under the deepest default that covers it. The check still only warns on agent-chat drift.
- 0443ad1: The sunset check lists a defaulted file only when it was added or modified since a base ref, and its count line names the covering defaults' fate tasks (TP-4405).
- c10380f: Shepherd now limits a conflicted PR's merge-order wait to the 15 min merging stall limit (TP-4434). Before, a PR queued behind a reservation that was held through a long review round sat in `merging` until the TTL. Now, once the limit passes, the PR leaves the wait and goes through the existing conflict wake. A wait that is still under the limit keeps the TP-4098 order.
- b345448: The main watch reads `shepherd.hubSeat` and `shepherd.redSeat` on every call, so an edit to either applies to the next sweep without restarting serve (TP-4484).
- ed07cc4: Shepherd's merge order holds a reservation only through a conflict round or at a landable head (TP-4497). A conflict wake keeps it, so nothing overlapping lands while the fixer merges main (TP-4098). It is released before any other wake (review FIX_FIRST, fix-proof, CI fix), once no fixer works on the conflict (an unhandled or exited wake, the owner gate, a demoted wait for a new head), and when a land round ends unmerged, unless a conflict wake ended it from inside and left a resolved head to land. Once a later head reaches the merge decision, the run takes the reservation again (`landable again at <sha>`) and overlapping PRs wait behind it. Expiry and `shepherd order clear` are unchanged.
- c74a74d: A build-surface spawn refused at the account limit no longer fails the step: the implementer runner waits until the reset the refusal names (`resets Jan 1 at 3:30pm (UTC)`) and asks again, and falls back to the load-deferral backoff when it names none.
- 7464e99: Shepherd's merge order no longer chains waits through a run still waiting for its turn (TP-4501). A reservation whose run sits in its order-wait step, with no conflict fixer at work yet, orders only other waiters, oldest reservation first, so a ready overlapping PR lands past it and two overlapping waiters never wait on each other. Once the run leaves its wait and its fixer starts, the reservation orders every overlapping PR again, as before (TP-4098).
- 796f38e: Shepherd retries a reviewer, successor or red-main fixer spawn on each later account in the review rotation when the broker refuses it with `reviewer_account_limit` (TP-4507). Other refusals do not fall back.
- bd3f2d5: A fresh build-surface start skips a slice whose PR already merged, found by the PR record or by the branch head being in the base, instead of running it again.
- c281d9a: When no fixer can start on a FIX_FIRST send-back, Shepherd now posts the reviewer's findings as one PR comment, marked per head so a repeat refusal finds it rather than posting again, and puts them in the seat's notice. Before this they lived only in the reviewer's transcript (TP-4560).
- 6622ea6: Shepherd wakes the fixer at once when a stacked child that GitHub retargeted after its parent squash-merged conflicts with its new base. The conflict no longer waits in the merge order (TP-4566). The wake is the existing conflict round, with the same brief and caps.
- b7b064f: The service deploy drain no longer waits on runs parked in `sh-order-wait`. They only poll for the PRs merging ahead of them and replay that wait under the new build, so counting them as busy stretched a deploy past 30 minutes (TP-4567).
- 907d9e6: The Shepherd merge guard no longer holds a run whose merge-order wait hit the merging stall limit behind a reservation whose holder is only reviewing its resolved head (TP-4569). Such a holder is in the TP-4497 review round: it has pushed past the head it reserved at and is not yet in its merge step. A run that never waited out its turn is still held as before.
- 2c55c17: Shepherd now sends a `--kind test-only` run on to review when its fix-proof is NO_REPRO on a diff of test support with no test in it, under `noReproProceed`. Such a diff plans no test, so the classifier flagged it and the run went back to its implementer and then to an owner `sh-sent-back` gate. Correctness and security runs on the same diff stay gated, as does any diff that changes source, deletes a test or does not read in full.
- 5a716b7: `/health`'s deploy block now counts a target the deploy pacer holds in deploy-wanted.json as waiting from its firstAt, and it folds in origin/main lag even while the pacer holds a target. Before this, a build many merges behind could read behind 0 with no alarm.
- 1aef05d: The owner digest's Seats section now counts merges and spawns per coordinator from the broker roster's spawned-by chains, instead of the seat book's dispatch journals, which no longer get written. The Spend section reads agent-chat's `pace.json` instead of `agent-chat digest --json`, which the installed agent-chat does not offer. `digest.logsDir` still loads but is no longer read.
- 9214ce6: The owner digest no longer runs `agent-chat digest --json`, which the installed agent-chat does not offer and which left asks, merged PRs, decided and stalled as one refused-flag gap line. Broker asks come from the merged owner list and merges from Shepherd, as the digest already read them. Decided answers and stalled claims have no supported agent-chat JSON read yet, so each prints a gap line naming that follow-up.
- b38d479: The deploy alarm no longer passes the pacer's 90-min cap. While the pacer holds a target the running build lacks, the "origin/main has held a commit" and "a deploy asked for" alarms wait for firstAt plus the cap, and the deploy line in `shepherd status` prints `cap HH:MMZ`. With no held target the 60-min threshold applies as before.
- 1473304: `titan-factory review` now reads a fix-proof standing without a Shepherd run (TP-4635): a `fix/` head branch or a `fix-proof` run at the head opens the gate, and the head's result line is read once through `readFixProof`'s own parser. A repo with no readable required checks takes its CI from the head's check runs instead of reading as pending, and the output's `CI:` line names the source.
- 4eb9812: An agent-chat call that finds no broker listening now throws `BrokerUnavailableError` instead of a plain `DispatchError`. Exit 69 (agent-chat's EX_UNAVAILABLE) always means an unreachable broker, and agent-chat's no-autostart probe line ("broker unavailable: no broker is listening and AGENT_CHAT_NO_AUTOSTART=1 forbids starting one") joins the whole-line broker-down list, because `agent ls` and the other legacy verbs exit 1 on it.

  Shepherd's review steps wait out an unreachable broker with a doubling wait (from the poll interval up to 2 min) for at most the review wiring's `brokerDownWaitMs` (default 15 min). Only then is the run held as no-reviewer, with the reason "broker unavailable (no broker answered for 15 min)". Before this change, a broker that came up after serve booted got the run held on the first refused roster read.

- c043c98: Audit step routes parse their input with a schema, so a wrong-shaped step prompt fails at the route.
- de3308e: A passing gate record that carries `failure: null`, as the gate README writes one, now parses as a gate record in build-surface instead of failing as "not a gate record".
- f1bb36b: Shepherd merges main into a green PR itself, through land's own update-branch, when main changed a guard or policy file (the stage-version and index-version guards, `.github/fix-proof.json`, the dead:check script and its baselines) since the PR's merge base, or when an approve-merge gate's only unmet MRG-AU condition is `no-non-green-run` and main's tip is green. A conflicting merge falls back to the existing conflict fix-round wake. `land` takes the new `mergeBaseFirst` option for this.
- a934683: The deploy pacer now deploys the newest green sha once main has been ahead of the installed build for 45 minutes (down from 90), so steady merges inside the quiet window no longer starve a deploy. A single burst is still debounced by the quiet window. `DeployPacerOptions.maxWaitMs` overrides the bound.
- d8e9fec: Shepherd: an approval that the accepted visual set gave now follows Shepherd's own clean merge-up of the base, and nothing wider. The base side must also change no path that matches the run's visual globs. The carry is logged as step `sh-approval-carry:<head>`, with rule `own-merge-up`, its proof and `origin: "approved-set"`. Land still trusts that answer for its own head only, so a later update asks again. Any other head, a base side that touches a visual path, or a policy with no visual globs asks the owner again. An owner's own approval follows as before.
- 8154858: Every Shepherd fixer wake brief, whatever its kind, now forbids rebasing or resetting the pushed branch and says to `git merge` an updated base or sibling PR and push a plain new commit, so a refused push is never retried.
- 195b283: Document the webhook ingress in the factory guide: path, port, secret file, kill switch, owner steps and rollback, with a test that pins the guide to the ingress constants.
- 34eb01d: Add the webhook projections (TP-3827): `INGRESS_KINDS` declares which GitHub events and actions the ingress stores, and `projectDelivery` turns one delivery into an event through the CI and repository key derivations, so a webhook row has the same occurrence key as its backstop row. Unlisted events and actions are ignored, and no pull-request title or body text is stored.
- 20c93ed: Record who actually withdrew an inbox deposit (TP-4121). `withdrawDeposit`, `restoreDeposit` and
  `withdrawMatching` take a required `actor`, refuse a blank one, and write it beside the asker
  (`by`) in the `<id>.withdrawn` marker and every `withdrawals.jsonl` row. A marker from before
  this has no `actor` and still reads. `WithdrawnItem` gains an optional `actor`, which the
  console's inbox read model fills from the marker.

  `titan-console inbox withdraw|restore|withdraw-matching` take a required `--actor <seat>`; a
  missing one exits 65 with one line on stderr. The console updater and the factory deployer
  record their own names as actor when they auto-withdraw resolved alarms.

- 4a2495f: Capability context: `WorkflowRuntimeOptions.capabilities` and `ctx.capability(name)` give step bodies an opaque handle whose declared secrets are refused (`CapabilityLeakError`) or redacted before they reach step output, the trace, the store or a prompt variable. The factory's guarded context forwards `capability`.
- Updated dependencies [ff061ba]
- Updated dependencies [9386796]
- Updated dependencies [59db533]
- Updated dependencies [c1af4ba]
- Updated dependencies [73c018b]
- Updated dependencies [74ad076]
- Updated dependencies [81395d7]
- Updated dependencies [9411e94]
- Updated dependencies [dcbf00e]
- Updated dependencies [e391005]
- Updated dependencies [d0d51f1]
- Updated dependencies [f85e2ba]
- Updated dependencies [e8159b1]
- Updated dependencies [cca108a]
- Updated dependencies [b7c8320]
- Updated dependencies [cfdfb64]
- Updated dependencies [cfdfb64]
- Updated dependencies [3fdf506]
- Updated dependencies [9411e94]
- Updated dependencies [91e3e3d]
- Updated dependencies [22f0205]
- Updated dependencies [ad0d9b3]
- Updated dependencies [a80e617]
- Updated dependencies [1732875]
- Updated dependencies [3ad8bee]
- Updated dependencies [af2b1e0]
- Updated dependencies [a50b511]
- Updated dependencies [b4b841b]
- Updated dependencies [e90522a]
- Updated dependencies [581c26f]
- Updated dependencies [25fcc67]
- Updated dependencies [b458a20]
- Updated dependencies [83a5759]
- Updated dependencies [4ea511b]
- Updated dependencies [2917ad8]
- Updated dependencies [6b7ee32]
- Updated dependencies [d666020]
- Updated dependencies [74fe992]
- Updated dependencies [6889f5d]
- Updated dependencies [7492819]
- Updated dependencies [1ac0fa2]
- Updated dependencies [24f1577]
- Updated dependencies [211db45]
- Updated dependencies [5ba850e]
- Updated dependencies [2256a3b]
- Updated dependencies [f896485]
- Updated dependencies [9c70c14]
- Updated dependencies [708e154]
- Updated dependencies [6a2471a]
- Updated dependencies [56d107b]
- Updated dependencies [0848c31]
- Updated dependencies [136b507]
- Updated dependencies [f5d92f3]
- Updated dependencies [292fbe9]
- Updated dependencies [ed8310b]
- Updated dependencies [fa9516b]
- Updated dependencies [26598f3]
- Updated dependencies [792265b]
- Updated dependencies [db5ea61]
- Updated dependencies [974b429]
- Updated dependencies [c15f0dc]
- Updated dependencies [5f2d9ed]
- Updated dependencies [d3d9a04]
- Updated dependencies [123f2d0]
- Updated dependencies [7b53127]
- Updated dependencies [dcaebb9]
- Updated dependencies [24f1577]
- Updated dependencies [b3209e3]
- Updated dependencies [b3f677b]
- Updated dependencies [84d962e]
- Updated dependencies [6c2df6a]
- Updated dependencies [a5f2f40]
- Updated dependencies [2c20516]
- Updated dependencies [2380fd4]
- Updated dependencies [7a34209]
- Updated dependencies [bea67f1]
- Updated dependencies [5993fba]
- Updated dependencies [f15a84e]
- Updated dependencies [5cd2a5a]
- Updated dependencies [cda1b03]
- Updated dependencies [7835f1b]
- Updated dependencies [ca8e8b7]
- Updated dependencies [f896485]
- Updated dependencies [a20c348]
- Updated dependencies [b6ce883]
- Updated dependencies [b6ce883]
- Updated dependencies [820d4d2]
- Updated dependencies [c18be57]
- Updated dependencies [ed2be7e]
- Updated dependencies [e623b29]
- Updated dependencies [6f1c6b9]
- Updated dependencies [fa60411]
- Updated dependencies [f325826]
- Updated dependencies [6554538]
- Updated dependencies [5a67a0b]
- Updated dependencies [cfdfb64]
- Updated dependencies [ff6fb95]
- Updated dependencies [423c9ce]
- Updated dependencies [c58d555]
- Updated dependencies [1640772]
- Updated dependencies [8b92ba0]
- Updated dependencies [c026f23]
- Updated dependencies [c525f57]
- Updated dependencies [36dc03f]
- Updated dependencies [f3d3107]
- Updated dependencies [a2df0c0]
- Updated dependencies [a2da8ac]
- Updated dependencies [0b09ff1]
- Updated dependencies [6525ba7]
- Updated dependencies [44038c9]
- Updated dependencies [7d3b5fb]
- Updated dependencies [481f3e4]
- Updated dependencies [661a027]
- Updated dependencies [801f9c4]
- Updated dependencies [9dd8d1c]
- Updated dependencies [207a81b]
- Updated dependencies [207a81b]
- Updated dependencies [377cca9]
- Updated dependencies [f1d79a5]
- Updated dependencies [f77d79d]
- Updated dependencies [5edd38d]
- Updated dependencies [9b42150]
- Updated dependencies [90f36b4]
- Updated dependencies [8e09d50]
- Updated dependencies [37d60d1]
- Updated dependencies [63ccb71]
- Updated dependencies [cd8a1ce]
- Updated dependencies [00fb3ee]
- Updated dependencies [c1f9297]
- Updated dependencies [5f33d7a]
- Updated dependencies [4080191]
- Updated dependencies [e63d1a9]
- Updated dependencies [661cf66]
- Updated dependencies [5f2b39f]
- Updated dependencies [51ee4c4]
- Updated dependencies [5e34e3d]
- Updated dependencies [52dc7f3]
- Updated dependencies [869014a]
- Updated dependencies [869014a]
- Updated dependencies [12afa80]
- Updated dependencies [32637bd]
- Updated dependencies [9a16e4e]
- Updated dependencies [3771a0c]
- Updated dependencies [2451aa9]
- Updated dependencies [d130bd8]
- Updated dependencies [cb470f4]
- Updated dependencies [2f306ce]
- Updated dependencies [181c229]
- Updated dependencies [49fa132]
- Updated dependencies [6d79a8b]
- Updated dependencies [852d2a9]
- Updated dependencies [d2cce6c]
- Updated dependencies [db14121]
- Updated dependencies [5833044]
- Updated dependencies [fcb7e85]
- Updated dependencies [6bc98f3]
- Updated dependencies [719f05e]
- Updated dependencies [36e0a48]
- Updated dependencies [3d709d8]
- Updated dependencies [147ff5d]
- Updated dependencies [4eb9812]
- Updated dependencies [1b0c46a]
- Updated dependencies [449504e]
- Updated dependencies [84114b3]
- Updated dependencies [9028bd0]
- Updated dependencies [9396ce4]
- Updated dependencies [29062e0]
- Updated dependencies [9d74995]
- Updated dependencies [78ae7d9]
- Updated dependencies [8031169]
- Updated dependencies [20c93ed]
- Updated dependencies [4a2495f]
- Updated dependencies [0229ba6]
- Updated dependencies [ee64f09]
- Updated dependencies [7012bf0]
- Updated dependencies [2165cec]
- Updated dependencies [50fd2a5]
- Updated dependencies [247171d]
- Updated dependencies [9ad447f]
- Updated dependencies [d5e44a5]
  - @titan-design/agent@0.7.0
  - @titan-design/agent-dispatch@0.10.0
  - @titan-design/autoresearch@0.1.0
  - @titan-design/authority@0.6.0
  - @titan-design/github@0.12.0
  - @titan-design/session-analytics@0.18.0
  - @titan-design/owner-queue@0.6.0
  - @titan-design/coordinator@0.6.0
  - @titan-design/fix-proof@0.9.0
  - @titan-design/review-panel@0.9.0
  - @titan-design/daemon@0.9.0
  - @titan-design/workflow@0.14.0
  - @titan-design/session-read@0.17.0
  - @titan-design/hitl@0.10.0
  - @titan-design/worktree@0.4.0
  - @titan-design/registry@0.6.0
  - @titan-design/review-workflow@0.1.0
  - @titan-design/store-sqlite@0.5.0
  - @titan-design/health@0.2.1
  - @titan-design/rpc-protocol@0.4.0
  - @titan-design/rpc-client@0.4.2
  - @titan-design/cluster@0.3.0
  - @titan-design/png-delta@0.1.0

## 0.25.0

### Minor Changes

- 749bea7: A pull request that only adds or changes tests can now prove itself without an owner waiver (TP-3658). `@titan-design/fix-proof` exports `provedByMutants(result)`: true when a `vacuous` result's mutation check is `killed`, every changed test file has a spec of its own in the diff, no test was deleted or renamed out of the tests, and every selected test ran and passed at head. The judge attaches mutants only to a diff `testOnlyReading` calls test-only, so one that deletes a test never carries them. The judge lists changed test files without a spec as `mutants.uncovered` and demotes `killed` to `not-killed` when any remain, so a spec beside an unchanged test cannot vouch for a test the PR changed. The fix-proof workflow gains a `fix-proof-mutants` job that runs `exec --side mutants` in the sandbox when the diff adds or changes a `*.mutations.json` spec, and the judge reads its report. Shepherd's fix-proof gate lets such a head go to review; a surviving mutation, a failing or unrun test, or a mutants error still ends the round as `NO_REPRO`, and the wake asks for kills. The tests reviewer's brief reads a proved head as proved rather than as a blocking vacuous proof. A run may now move into `--kind test-only`, under the existing diff check.

### Patch Changes

- e9e4bb7: Shepherd's registration hold follows review policy 458's sign-off classes, given by the new pure `requiredSignoffs`. One correctness sign-off is the default. Size, a migration, a security kind with no sensitive path, and unread line counts no longer place a `g10-review` hold; they still pick the g10 (Opus) correctness reviewer. A store-migration touch now reaches that reviewer through its own `migrationTouch` reviewer fact, with Shepherd's migration globs (`store-migrations.ts`, `*-store.ts`, `*-migration*.ts` and Shepherd's store, events and train files), rather than through the hold it no longer gets. Only an adversarial path (authority, policy or security) places `g10-adversary`. That list now also covers the console's owner-tap and inbox actions, gate resolution, owner release (matched by name stem, so a helper split out of those files stays covered) and agent-chat's agent profiles. A hold placed by hand is unchanged, and so is the fail-closed `g10-adversary` hold for an unread file list.
- Updated dependencies [749bea7]
  - @titan-design/fix-proof@0.8.0
  - @titan-design/review-panel@0.8.1

## 0.24.3

### Patch Changes

- ecc0f82: TP-3697: Shepherd demotes two always-approved owner gates, each leaving an audit record (PR comment, watch row `autoPassed`, owner digest FYI section). D7 failed-rounds: when every counted round failed on infrastructure, one fresh reviewer goes before the owner, and the owner is asked only if it fails too; D7 never merges by itself. D13 main-red: the acknowledge-only gate is an FYI record. `GATE_DEMOTIONS` reverts each class with one line. Visual and gate-2-visual gates (D2) still wait for the owner.
- Updated dependencies [cda3cbe]
- Updated dependencies [a16ce17]
- Updated dependencies [a16ce17]
- Updated dependencies [a16ce17]
- Updated dependencies [a16ce17]
- Updated dependencies [a16ce17]
- Updated dependencies [a16ce17]
- Updated dependencies [a16ce17]
- Updated dependencies [a16ce17]
- Updated dependencies [a16ce17]
- Updated dependencies [a16ce17]
- Updated dependencies [a16ce17]
- Updated dependencies [a16ce17]
- Updated dependencies [a16ce17]
- Updated dependencies [a16ce17]
- Updated dependencies [a16ce17]
  - @titan-design/agent@0.6.2
  - @titan-design/worktree@0.3.0

## 0.24.2

### Patch Changes

- 653ecf6: Shepherd's two-MERGE release of a `g10-adversary` hold no longer requires the correctness reviewer and the adversary to run at different profiles. Decision 457 runs both on `bd-reviewer`, and under the old rule no such hold could release. Two MERGEs now count as independent when the broker roster shows the reviewers share no conversation: separate sessions, and no resume, context fork, takeover or common spawning session between them. An unread roster fails closed. Correctness must still run on an Opus profile (TP-3524).

## 0.24.1

### Patch Changes

- d82852a: TP-3637: a decided answer never waives a fix-proof. `ServiceAnswer` now carries the broker's `provenance` marker when agent-chat sets one. gateNotify refuses a `decided` answer on every gate, because it would resolve as owner-remote and the decider is not the owner. It also refuses a `waive-proof` answer unless it is `human-endorsed`, so an unmarked relay fails closed. A refused answer leaves the gate pending, settles the ask as `refused`, and writes no waiver row. The owner's own terminal answer still waives.
- 4bfc8a3: Resync PR-read deadlines now arm through an optional `readTimer` on `ShepherdServices`, defaulting to the wall clock. A test can pass a deadline in by hand instead of faking global timers, which also captured the seed host's gate polls and made the hung-read test time out on a loaded runner (TP-3647).
- Updated dependencies [d82852a]
- Updated dependencies [9914239]
- Updated dependencies [9914239]
- Updated dependencies [9914239]
- Updated dependencies [6dd2f97]
  - @titan-design/agent-dispatch@0.9.0
  - @titan-design/agent@0.6.1
  - @titan-design/session-read@0.16.1
  - @titan-design/session-analytics@0.17.4
  - @titan-design/worktree@0.2.0
  - @titan-design/coordinator@0.5.3
  - @titan-design/workflow@0.13.1

## 0.24.0

### Minor Changes

- 8af5ad7: TP-3639: `titan-factory shepherd freeze <owner/repo> --reason <text>` and `shepherd unfreeze <owner/repo>` set and lift a coordinator's merge freeze on a whole repo; `shepherd freezes` lists them. While a repo is frozen no Shepherd run merges into it, though runs keep reviewing and CI keeps running; unfreeze lets waiting runs merge on their next step. The freeze is stored in the factory database (migration 33, `shepherd_repo_freeze`), is checked by the same merge guard as the main-red freeze, and is independent of it. `status`, `list` and `timeline` rows carry it as `repoFrozen`.

### Patch Changes

- e7601ef: TP-3642: the panel aggregate honours the owner's fix-proof waiver. `AggregateInput.fixProofWaivedAt` keeps a vacuous, missing or failed fix-proof from making the tests member blocking, or from counting an unplanned tests member as missing, only when it equals the head; a waiver at any other head changes nothing. `reviewPullRequest` and Shepherd's sh-review-panel step pass it through.
- Updated dependencies [e7601ef]
  - @titan-design/review-panel@0.8.0
  - @titan-design/session-analytics@0.17.3

## 0.23.5

### Patch Changes

- 454eb53: A `NO_REPRO` `sh-sent-back` gate now offers the owner a `waive-proof` answer bound to the gate's head. It is never recommended, and no coordinator or decider answer can select it. The waiver is stored per run and head in `shepherd_proof_waiver`. The next round then reviews that head, and its MERGE withholds the merge-on-green grant, so it reaches only the owner's `approve-merge`. A new head is gated again. `FIX_FIRST` send-backs do not offer it.
- 1581171: Shepherd's test-only diff reading now flags a PR that deletes a test or changes no test, and reads every listed path's blob first: a gitlink, a large file, a missing blob or more than 100 paths reads `unread`. A move into test-only is refused for every reading but `test-only`.
- 27f8d12: TP-3638: the reviewer brief says "fix-proof waived by owner" when the owner's waive-proof names the head under review. `ReviewerBriefInput.fixProofWaivedAt` replaces the fix-proof reading (and the tests member's) only when it equals the head; a waiver at any other head leaves the brief unchanged. Shepherd's review phase passes the waived head to `sh-review`.
- Updated dependencies [27f8d12]
  - @titan-design/review-panel@0.7.0
  - @titan-design/session-analytics@0.17.2

## 0.23.4

### Patch Changes

- 53d153a: Answer a console owner-release whose PR head moves during the release itself with 409 `moved` and GitHub's head, not 410 `gone`. The hold is kept, as before.
- Updated dependencies [4d131dc]
- Updated dependencies [41fce70]
  - @titan-design/fix-proof@0.7.0
  - @titan-design/owner-queue@0.5.0
  - @titan-design/session-read@0.16.0
  - @titan-design/review-panel@0.6.2
  - @titan-design/hitl@0.9.1
  - @titan-design/session-analytics@0.17.1

## 0.23.3

### Patch Changes

- 6a847ae: `shepherd register --kind test-only` reads the PR's test-only diff before refreshing or restarting a run, so the kind guard names the first source path when it refuses (TP-2732 e). Once the kind is live, a correctness registration on a tests-only PR prints a hint to re-register as test-only. The CLI help and the Shepherd guide name the kind.
- Updated dependencies [6aa69f2]
  - @titan-design/fix-proof@0.6.0
  - @titan-design/review-panel@0.6.1

## 0.23.2

### Patch Changes

- Updated dependencies [48fc4c0]
- Updated dependencies [9b5d49f]
  - @titan-design/coordinator@0.5.2
  - @titan-design/daemon@0.8.0

## 0.23.1

### Patch Changes

- c60f812: Add `POST /owner/console-action`, mounted when `shepherd.consoleAnswers.actionsDir` is set. It resolves an approve-merge gate (the `shepherd-release` Version Packages gate included) as owner-remote from the console inbox's action record, read O_NOFOLLOW and size-capped from that dir; the body names only `{ actionId }`. Hardware, after-stages and other gates are refused, as is a record whose head GitHub has moved past.
- 3592aa2: `POST /owner/console-action` also takes an `owner-release` action record: it lifts the owner-asked hold on the record's PR, and only that hold, as owner-remote from the console inbox at the head the owner confirmed. The answer is `released` (with any hold still in force as `stillHeld`), `already` for a replay of the same record, `moved` when GitHub's head differs, `gone` for a PR with no owner-asked hold, and `refused` for a record that names its own resolver.
- 17a0fe6: Shepherd: when the owner accepted a red head's regenerated baselines, a later head that commits exactly that set (every changed path in the set, each file at its accepted blob, each removed file gone, nothing else) has its visual approve-merge gate answered `merge` by code and logged as step `sh-approval-carry:set:<head>`. Under `shepherd.visualSetCarry: shadow` the step records whether the set would carry and the owner is still asked. With the flag `off`, the default, nothing changes. The set carries only onto a gate into the base its red head's CI read was judged on. It is used up once it is checked, or once the owner answers a visual gate themselves, and a later answer at the accept gate replaces it. An approval that came from a set does not yet follow a later merge-up.
- Updated dependencies [7a4d313]
  - @titan-design/coordinator@0.5.1

## 0.23.0

### Minor Changes

- e3e42a0: The owner-presence helper gains `keygen`, `pubkey` and `sign` for a Secure Enclave P-256 key that needs Touch ID or the login password for every signature. `keygen [--tag <tag>] [--replace]` writes the key's opaque enclave blob with mode 0600 to `~/Library/Application Support/titan-factory/<tag>.se` (tag `owner-key` by default) and refuses to overwrite it without `--replace`. `pubkey [--id]` prints the SPKI PEM, or a 16-hex key id from sha256 over the SPKI DER. `sign [--] <reason>` signs the bytes on stdin and prints a base64url DER ECDSA P-256 SHA-256 signature. With one argument the helper still shows the presence dialog and prints a proof id. `signStatement(bytes, reason)` runs `sign` through the same helper path checks as `confirmOwner` and returns the signature, or undefined. Rerun `pnpm factory:install`, and the root `install` if you use one, to rebuild the helper.
- 6a733e1: Shepherd exports its reviewer-slot reading (TP-2828). The spawn gate keeps the last roster reading of running `rv-` reviewers, and serve reports it in `/health` as `reviewSlots: { running, cap, readAt }`. A failed roster read keeps `rosterError` and no `running` list. `shepherd status --json --deploy` carries the block as `reviewSlots`, or `null` when serve has none. Text `shepherd status` ends with `reviewers R/cap`, or `reviewers unread (<why>)`, never 0.
- 65287ec: `titan-factory shepherd prs [owner/repo] --json` lists every open PR of each seat repo, or of the one named, from Shepherd's PR snapshot, plus the PRs Shepherd merged in the last 24 hours. Each row carries the branch, head, base, state, title, body, draft flag, whether Shepherd has it registered (with its run id and phase), the snapshot's cached CI for the head when it holds one, its source and when it was read. Open rows answer with no GitHub call while the open list is under a minute old, and concurrent callers share one list read. A merged row's `mergeSha` comes from the run's merge step, never from a PR read. A seat repo with no run in it is still listed.

  `@titan-design/github`: `PullRequest` gains optional `title` and `body`, which the gh wire now fills from the REST answer (a null body reads as an empty string).

- c0af8a0: `buildOwnerSection` builds the owner PR section (link, what it does, why it reaches you, pros, cons, before and after, next steps) plus a round@2 section and a pick-one question with a recommendation, from the PR facts, the pending gate, the run's owner-gate reason and the reviewer's verdict and owner brief. `whyAsked` maps every gate rule (seat owner-gate, every merge-guard row, authority MRG-AU unmet conditions, route escalations, release rows and the factory default) to one plain sentence labelled deliberate, accidental or unclassified. The gate head and the review head are read apart: a missing review, a review behind the PR head and a gate behind the PR head are each stated, and none recommends merge. A merge-tree-clean failure is called transient only when the evidence recorded mergeable_state unknown.
- fcb7748: Add `shepherd.review.panel` (`off`, `shadow` or `on`; absent means `off`). Under `shadow` the `sh-review-intent` step also records the head's class, touches and review-panel plan, built with `classifyPr` and `planPanel` from the registered kind and the PR's file list; the reviewer dispatch and every later step stay as under `off`. Until per-member review lands, `on` behaves as `shadow`.
- b0a3f7b: `shepherd.review.panel: on` now reviews a head with its planned panel. The correctness member keeps `sh-review:<head>` and `sh-await-verdict:<head>`; every other member runs `sh-review:<head>:<shape>` and `sh-await-verdict:<head>:<shape>` at its planned profile with its shape's brief, and `sh-review-panel:<head>` records the aggregate. A panel MERGE carries `panel: {satisfiesG10, degraded, members}`, and a panel FIX_FIRST carries each member's findings and the panel's defect class. A run whose intent recorded no plan continues as a single reviewer. `ReviewerFacts` gains `profile`, which a reviewer dispatch spawns at in place of the class's profile.
- 8dcc60f: Add a toolchain adoption sweep: `serve` runs it hourly (`toolchainSweepMs` overrides), and `titan-factory toolchain fanout [--dry-run]` runs it or previews it on demand. It reads every consumer repo's Node and pnpm toolchain against titan-platform's, opens one adoption PR per drifted repo through the contents API, and registers it with Shepherd with no fixer and an owner-gated merge, because these PRs edit other repos' release workflows. An existing PR on the toolchain branch is registered if Shepherd does not know it yet, and a closed one is never reopened.
- 7f21489: `titan-factory scorecard --spec <file> [--since YYYY-MM-DD] [--until <time>] [--json]` prints the factory scorecard: the ledger rows (merges per day, task ready to merged, register to merge, change failure rate, time main stays red, seat merge share, approved and waiting over 60 minutes) plus session-analytics' journal rows, with each row's baseline and target read from the spec. A row with no source prints `not measured`; a missing spec or unset `AUTONOMY_ROOT` and `ACTIVE_ROOT` exits 2.
- 7f6205a: Add an owner-signed `titan-factory.hold-release` statement, `verifyHoldRelease`, `applyHoldRelease` and serve's `POST /holds/release-proof`, which lifts one Shepherd hold bound to its run, reason digest, PR head and audience (TP-2378 a).
- 857c1f9: Shepherd never re-dispatches a reviewer at a head that already took a MERGE (TP-2392 d): a resync review-again re-reads the merge evidence with the standing MERGE and records `sh-review-refused`, and `shepherd review` at a MERGE head exits DATAERR.
- 3f3d477: Shepherd stops a run at its third FIX_FIRST review (was six) and opens approve-merge with a reason that routes the task to the planner for a redesign or split; the cap is checked before `no-progress`, and no third fix round is dispatched (TP-2394 c).
- 01ff3ee: `shepherd register` returns an advisory `sizeFlag`, and the text output prints a warning line, when a PR registered with kind `security` or touching a guard area is over the 400 non-generated line slice cap (review-panel `securitySliceFlag`). The flag never holds a PR. A failed read, or one that runs past 15 s, gives no flag and never fails the registration.
- e4ce510: Add `titan-factory service pause --set <reason>`: a manual deploy hold in `deploy-hold.json`, honoured under `deploy.lock` and by the deploy pacer like the failure pause; `service pause` and the deploy refusal show both reasons, and `--clear` lifts both.
- 1286557: `shepherd stats --gates --since 7d` meters gates by policy row and resolver (owner-terminal, owner-remote, coordinator, delegate, unanswered) with decisions by value, cancelled-unanswered, pending, and median and max wait hours, as text or `--json` (TP-2402 b). The owner-friction report and the SLO owner-load queries now share `isOwnerTouch`, which leaves out an owner-class resolve made under a grant. History does not change, because no older row carries grant evidence. Only delegate resolves recorded from now on drop out of owner touches, so a drop next week reflects that change and is not a meter regression.
- e69cef1: Factory gates become full owner cards: `decisionClassOf` maps each gate's policy row or step to its decision-routing D-row, and hitl owner items carry `class`, `irreversible`, `shown`, `onSilence` and a consequence per option, with `lint` naming any card rule a gate still breaks. `titan-factory needs` prints the class, door, on-silence line and consequences.
- 799f267: `titan-factory owner-gates report` prints, per decision class over a trailing 14-day window, the owner-answered gates, approve rate, cancelled-unanswered and median wait, built on the `shepherd stats --gates` meter. A resolve made under a grant is not counted as the owner's. A class at 95% or more approve over 20 or more answered is flagged with a proposed demotion to a rule, the reviewer or the decider, unless the audit found a bad outcome in it. The report lists the standing grants with the gates resolved under each, and `--deposit` files one two-way owner card per proposed class, once per ISO week.
- dba7139: `shepherd status` accepts `--all` (every run, terminal ones included). Output is unchanged for now; a later release makes the bare form leave out done, failed and cancelled runs, and `--all` keeps them (TP-2516 a).
- 36b4295: Shepherd cascades a stacked parent's new head into each child by update-branch, wakes a conflicted child, and `shepherd status` rows carry `stackFrozen` past 2 parent fix rounds (TP-2528 c); the cascade is not wired into the run yet.
- 0920da2: Opt-in per repo with `shepherd.repos.<repo>.stackRestack: true` (off by default): after Shepherd's own squash merge of a stacked parent, each direct `agent-chat/*` child is restacked with a merge-onto commit and a plain fast-forward push, then retargeted to the default branch while its base is still the parent's branch, and recorded as `sh-restack:<pr>:<head>`; a conflict, guard miss or moved head pushes nothing and wakes the child's implementer, and a failed child-list read records `skipped` so post-merge continues (TP-2528 e).
- 954a5af: Shepherd's head waits end on the seat clone's push reflog instead of a 30 s GitHub poll (TP-2555 g). A new
  `shepherd/push-signal.ts` reads `logs/refs/remotes/origin/agent-chat/*` since a cursor; a reflog push is confirmed
  with one snapshot `getPr` after the repo is marked stale, and with no reflog movement the PR is read once per
  `AWAIT_HEAD_BACKSTOP_MS` (5 min) for pushes from outside the clone. `untilGreen` and `sh-fix-proof` read checks at
  the snapshot's 3 min pending cadence. `AWAIT_HEAD_POLL_MS` is no longer exported; `AWAIT_HEAD_BACKSTOP_MS` replaces it.
- f2703bd: `shepherd register` takes `--head` and `--base`. With `--branch` and `--head` it trusts the branch and does not read the pull request from GitHub. The registration stores the head and base (store migration 24), and Shepherd classes the PR's G10 hold, its review panel and its reviewer's size from `git diff --name-status -M <base>...<head>` in its git cache, cached by head. A registration with no base, or a head git cannot fetch, still reads GitHub's file list.
- 027f0f2: Serve reaches GitHub through `octokitWire` on one shared client per process, and so does the review-check publish (TP-2561 b1). Two new RPCs:

  - `shepherd.ghRead` answers whitelisted GET routes through that client's ETag cache, or from the PR snapshot. It refuses any other route or method.
  - `shepherd.ghBudget` reports the client's rate windows and cooldowns.

  Each real gateway call logs one `shepherd: gh-call` line.

- ac8bf42: Shepherd no longer withholds the merge-on-green grant for an unverified fix-proof (owner decision 303, reversing TP-2434). A fix-proof read that errors is read once more at the same head first. The unverified standing and its read reason are recorded on the merge evidence (`proofUnverified`) and in the evidence PR comment, and an unverified proof no longer asks the reviewer for an owner brief. The reviewer's unverified-proof brief no longer says a MERGE goes to the owner.
- bf1a082: `shepherd.ghRead` takes `raw: true`, which skips the PR snapshot so `repos/{o}/{r}/pulls/{n}` answers with GitHub's REST JSON through the budgeted path.
- 14f1997: Shepherd can spawn a review packager when it opens a visual approve-merge gate (a `shepherd-merge-guard/visual-path` gate, or any land gate of a `gate-2-visual` registration), once per run and head, behind the new `shepherd.visualPacket` flag: `off` (default), `shadow` (records where it would spawn) or `on`. `shepherd.visualPacketProfile` names the profile, default `review-packager`. A refused spawn is recorded as `visual-packet-spawn-failed` and the gate opens as usual (TP-3227).
- 7873703: Add `POST /gates/answer-ship`, mounted by serve only when `shepherd.consoleAnswers.roundsDir` is configured. It resolves an approve-merge gate as `owner-remote` (`titan-console`, `console:ship`) from a console Ship answer once the gate, GitHub's head and tree, the round's packet and the owner's feedback all agree, and appends a `pick-later` line to `follow-ups.jsonl` for `merge-pick-later`. It is no registry command and no MCP tool.
- ceb20d1: Let the owner send a PR back from the approve-merge gate. With `shepherd.consoleAnswers` configured, each shepherd-pr approve-merge gate offers `send-back`, whose payload `{decision: "send-back", headSha, note}` the gate store refuses without a note. Land stops `sent-back`, and Shepherd wakes the implementer's review fix with the note, then waits for a new head and never merges the sent-back one. `POST /gates/answer-ship` now resolves an agreed send-back, taking the note from the owner's `feedback.json` (the round's `general` text, then the Ship question's `comment`).
- 4b03e77: The factory config gains a strict top-level `github` block: `sources` (`webhook` or `polling`, default `polling`), the `ingress` kill switch (`on` or `off`, default `off`), `pollingIntervalMs` (30 s to 10 min, default 60 s) and `backstopIntervalMs` (5 to 10 min, default 5 min). A polling interval longer than the backstop, or ingress on under polling, fails the load. Serve's health gains a `sources` field with the configured and effective mode, the reason, the interval and, when the file on disk has turned invalid since start, the `configError` that kept the last good value in force. Nothing acts on the effective mode yet.
- 5e8d988: Shepherd repair stop: `shepherd repair-stop <owner/repo#N | owner/repo:<glob>> --reason`, `repair-go` and `repair-stops` set, clear and list a seat's stop on fixer dispatch. While a stop covers a run, Shepherd wakes and resumes no fixer for it and spends no repair, even under `heldRepair: on` with a g10 hold, and the release path is unchanged. Migration 31 adds `shepherd_repair_stop` and the `repair-stop` and `repair-go` event kinds.
- 03ea942: `titan-factory serve` broadcasts versioned `shepherd` frames on `/events` (`{v:1,kind,repo?,pr?,runId?,stepId?,at}`) from host workflow events, Shepherd registration writes and a `PRAGMA data_version` poll that marks another process's commit `external`, coalesced 250 ms per run (TP-493). `ShepherdStoreRef` gains an optional `onChange`.
- 4e4613c: Land stamps an approve-merge gate with its table.json row: `authority/MRG-AU` gets that row's resolvers plus `coordinator` as a rule delegate; release and every other table open rule-less. The factory host runs `gateRuleMigration(27)` and `gateDelegateMigration(28)`, and `deviceGateAuthorize` refuses a rule delegate only when nothing but the rule admitted it, so TP-1904 evidence resolves still pass (TP-533).
- 359301b: The owner digest has a "Decided for you" section after Needs you. It lists the questions the decider answered in the window, read from `agent-chat digest --json` (`ledger.decided`). Each line shows the answer, the class, and, when agent-chat sends them, the confidence, the principle ids and how to reverse the decision. A decision awaiting audit also shows its overrule command. The section ends with the 7-day reversal rate per class. Decisions only use the words left under the 400-word limit, and the "and N more" line counts the rest. With an older agent-chat the section is left out.
- d0c584f: `shepherd stats --gates` reports visual-gate latency (count, median and p90 hours from open to resolve, open gates counted apart) and re-asks per PR, as a new `visual` JSON field and two text lines.

### Patch Changes

- 6b5ff45: await-new-head: a wait that carries its failing checks and an `inheritedRed` hook re-asks, at most every 5 min, whether the unchanged head's red is the base's, and ends with `baseRed: true` once it is. `LandPrDeps.inheritedRed` passes the hook to land-pr's route. With no hook or no failing checks the wait is unchanged.
- 3108023: `shepherd resync` and serve's startup resync now cancel an approve-merge gate whose PR base moved, or whose base the run may not merge into, as the head-moved sweep does each tick. A run with an owner hold keeps its gate.
- 6654aa7: Add an operator HOLD reader over `agent-chat machine status --json` for Shepherd (CC-1037 a); not wired yet.
- 13cbaba: Shepherd waits 90 s, not 30 s, for agent-chat roster and spawn calls, so a loaded broker no longer leaves a PR without a reviewer (CC-1310 a). Goes live on the next factory serve restart.
- 616d699: `titan-factory serve` warns on each agent-chat call over 5 s and logs an hourly per-verb "agent-chat calls" line with count, over5s, p95Ms and maxMs.
- 5d67fb0: Add the gate-ask store and `notifyTick`: each gate the owner can answer is posted once to agent-chat's human queue, and an answer applies at most once. The factory database gains a `gate_ask` table and a `gate_ask_cursor` table in migration 20.
- 50950cc: Add `shepherd.gateNotify`: with it set, serve runs a sweep that asks pending decision gates on agent-chat's human queue and resolves them from the answer as `owner-remote`. `/health` gains a `gateNotify` block naming stuck and unasked gates and an answers read error. Off by default.
- 41ad016: `titan-factory needs` shows a gate and the notifier's agent-chat ask for it as one item: an ask whose task is `gate:<id>` keys as that gate instead of `task:gate:<id>`.
- 6327db9: Read a console Ship-view Send back, the pick of the question's one non-ship option, as a send-back; the factory refused every one because it only read `revisionRequested`.
- c832620: The deploy block and the deploy pacer count a running build that descends from an asked or wanted sha as having landed it, so a later commit deployed by hand no longer reads as a stalled deploy. When git cannot settle ancestry the ask stays behind and the block says why.
- a71cc2a: `service deploy` keeps a failed install or build's redacted last 200 lines of stderr and stdout in `deploy-build.log` under the state dir, and the rollback record's `why` names it.
- 51fcac6: The deploy watch's docs say why it has no start-up grace: the sha poll already waits for a first answer, and three live-pid misses take about 135 s, past the 120 s window and the 17–32 s Shepherd resync after a restart.
- e84df44: The deploy watch now tells a slow serve from a down one. A `/health` probe that times out while the restarted pid is still alive is retried once with a 30 s timeout; an answer on the retry is slow and does not count toward the miss limit, while no answer still does, whether or not the pid is alive. A watch window in which every probe was slow rolls back with "serve answered slowly" and the latencies it saw.
- 4af14bf: The factory database gains migration 30, `factory:event_log`: an append-only `factory_event` table, with UPDATE and DELETE aborted by triggers. Internal `appendEvent`, `headSeq` and `readEvents` write and read it. Nothing reads it yet.
- 939b8e4: `shepherd status --deploy` reads how far origin/main is past serve's running build from git, so merges that never asked for a deploy count as behind, `behindMinutes` runs from the oldest of them, and an unreadable git or an unknown running sha alarms instead of reading behind 0.
- 071bb72: Push an ntfy line when a visual packet's round is delivered to the console, and withdraw the round (with a second line for a new head or a closed PR) when its gate leaves; `visualDelivery` gains `push`, `origins` and `url`.
- 1307977: Fence the PR head branch in the successor brief so a backtick in a ref name cannot close a code span and read as brief prose.
- a00fec2: Add the owner-gate auditor library (TP-2404 d): a week-seeded sample of up to 5 owner-resolved gates, their 72 h outcomes (revert, red main, linked deploy incident), a sonnet judge note per item, and a no-clobber writer for `sources/owner-gate-audit-<YYYY-Www>.md`. Not wired to a verb yet.
- f2a492d: An unhandled owner send-back now opens a sent-back gate in plain words, with the PR, the head and the owner's capped, fenced note.
- 1c7fde2: Shepherd's PR snapshot keeps the open list's ETag across `invalidate`. An invalidate now marks the list and the check runs stale and drops the PR details, but keeps the ETag, so the read after a write is a conditional GET: a 304 keeps the rows and a 200 replaces them. Check runs are read again after an invalidate, so a re-run of failed jobs is seen at once. A list read that an invalidate overtakes is dropped and read again.
- bf43cf7: The deploy watch no longer rolls back on a rate-limited probe. A 403, 422 or 429 from `/health` reads as unavailable, which is neither healthy nor an error: the window extends, restarts on fresh probes once reads return, and at a 10-minute cap the deploy is held with an alarm instead of rolled back. TP-3085.
- 9c6d6c4: Shepherd no longer parks forever when CI at the same head turns green. A cancelled run's reds beside a live or passed run at that head no longer read as red, and a wait for a new head after a ci-red also ends once every required check passes at the unchanged head (a rerun or a late run), so the run goes on to review and land there.
- 50062e0: `shepherd status` marks a run stalled when it is held `g10-review` and no reviewer MERGE is recorded at its head, once it has waited more than 60 minutes in its merge step or in `sh-held-wait`. Only that MERGE releases such a hold, so before this change the run waited silently with no end. Owner holds, other hold classes, and holds satisfied at the head still have no limit.
- c0e20df: Shepherd: a held run that woke on red CI no longer waits in `sh-held-wait` forever when a rerun turns the held head green. The wait now also ends, once per head, when every required check at the held head passes; the next round reads CI afresh and goes on to review with the hold kept. FIX_FIRST and conflict wakes still wait for a push or a release, and a repo with no required checks keeps the old behaviour.
- f52f65c: Shepherd: a held run woken by a red head reruns that head's failed jobs once, sharing the once-per-head rerun budget with unheld runs, before it tells the seat and waits. A head the rerun turns green is reviewed with the hold kept, so a held red head no longer waits on someone else's rerun (TP-2836). The seat notice for a head still red says Shepherd's one rerun is spent. A run recorded before this change replays its old path.
- bb86d3f: A `g10-adversary` hold the seat released is re-held when the PR's head then moves to anything but a clean merge-up of the released head (a fix round, a fixer's push, or a merge-up whose conflicts were resolved by hand). Shepherd records a hold event naming the old and new head and tells the seat; a head whose tree equals the merge-tree of its parents stays released. `shepherd release` now requires `--head <sha>`, the head the seat reviewed, refuses it when the PR is at another head or the head cannot be read, and records it. A re-hold is written by a compare-and-swap, so a hold or release made while the probe runs is never overwritten. The merge check enforces the rule too, so a head no CI read saw (a hold of another class released after the last read) is refused and re-held at the merge. `shepherd release` refuses a run that is not held. A chain of clean merge-ups stays released at both the CI read and the merge, which share one recorded line of proven heads. A hold of another class placed beside a `g10-adversary` hold is kept, and gates once the adversary hold is released; each release lifts one hold. The rule fails closed: a repoint keeps the run's hold history and proofs, the registration row decides whether a hold gates, a proof counts only on the base branch it was made on, and an adversary release with no head is re-held. `shepherd release` takes `--class <class>` to name the hold it lifts; while a `g10-adversary` hold sits over another, a release that names no class is refused, and every release reports the hold still in force.
- f014023: Shepherd's rerun step no longer gives up on a failed job whose Actions run is still in progress. It polls until the run completes, within a 20-minute `rerunQueueMs` bound, then reruns it. If another actor's rerun already replaced the failure, it settles without rerunning. The next ci-wait then reads the rerun's result, not the stale red.
- b899b0e: Shepherd waits out a seat reviewer's WAIT over its own MERGE for up to `seatWaitMs` (30 minutes by default). If the WAIT outlasts the bound, the review ends as `external-hold`, with the own MERGE kept as `seatHeld`. It is no longer a `timeout` that spawns a fresh reviewer, and it skips the late read and the correction turn.
- be5000e: The seat check can wait out a seat reviewer's WAIT over Shepherd's own MERGE: given a seat-wait timing, it re-reads the seat until the WAIT ends, lets the MERGE stand on a seat MERGE, records a `g10-disagree` override on a seat FIX_FIRST, and holds the MERGE as `seatHeld` when the WAIT outlasts the bound. Without the timing the WAIT still vetoes at once; nothing passes the timing yet.
- 238f901: Shepherd merges up a ci-red head whose failing checks all failed at the base its CI ran against, once that base has moved on, with no wake, repair or seat notice (TP-2562 a). The base-red hold record gains `stale`, and a freeze or base-red refresh records its own head so it is no foreign merge-up.
- 9f5407c: `shepherd stats` counts a freeze-hold update that followed a red-base wait as its own `mergeUps.baseRed` class, printed as `base` in `merge-ups land/strict/freeze/base/retry`.
- 4e9cc64: `service check` names an advisory `stale CLI` when the `titan-factory` on PATH carries a build behind the deploy checkout's HEAD (TP-2265); it still exits 0.
- 82cab44: `shepherd.status` takes an optional `all` arg. Without it, and with no PR named, serve leaves finished runs out before loading any, so a bare `shepherd status` no longer parses every run's step results. `shepherd status --all`, or a `--phase` naming a finished phase, sends `all`.
- 4fa6379: Serve's head-moved sweep no longer cancels the approve-merge gate of a run under an owner hold when its PR base moved, so the gate is kept for both serve and `shepherd resync`. The owner hold is read again right before the cancel. A dry-run resync also lists a gate once when both the transient and the base sweeps would cancel it.
- 91a6242: Shepherd follows a merged Version Packages PR to npm once main CI is green: it records the published versions, files one fix task when the release job fails, and ends without a gate on a failure or timeout (TP-1004 S2).
- 9abae48: Reviewers run no tests: the default reviewer test rule, now exported as `CI_REVIEWER_TEST_RULE`, has them cite the CI check-runs (name and conclusion) at the reviewed head and treat a missing, running or red required check as blocking. Shepherd uses it on every host, and its fixer rules name `pnpm test:affected` (TP-1727 slice 3). The review-pr eval's offline trial brief swaps in its own no-CI test rule.
- e58a580: Add the PR reads for `titan-factory review` (TP-1925 b): `parseTarget` for `owner/repo#N`, `readPrFacts` over the GitHub port, and `ghLineSource`, a lazy, cached file reader over `gh api` capped at 20 files. Not wired to a command yet.
- 36af0d9: Land reads classic branch protection when the rulesets require no status checks, and a base with no required checks no longer lands a head whose Actions runs were all skipped.
- ad1101b: Add `ownerKeyId`, which reads the owner's Secure Enclave key id through the checked owner-presence helper (`pubkey --id`) so the Mac client can refuse before prompting when its key is not installed on the remote factory.
- 7731c3a: Add the owner proof statement builder (TP-2036 b): `gateItem`, `buildGateStatement` (240 s window, schema-checked) and `signReason` (the Touch ID dialog text, at most 256 characters); not wired yet.
- 83d4e91: Add `remoteFactory(base, fetch)`, an HTTP client for the live factory named by the `remoteFactory` config: it reads `factory.gates-review` and the owner key ids in `/health`, and posts owner proofs to the two proof routes. Every request carries the client header, a 20 s timeout and never follows a redirect. The base must be a bare origin and paths plain absolute paths. Non-2xx reads, oversized or duplicate gate lists, control characters, and proof answers without outcomes are failures; a refused or timed-out connection is an `UnavailableError` naming the URL (TP-2036 c). Not wired yet.
- 517ea4b: Add `shipAtHead` to Shepherd's round-merge: a review-round Ship at a PR's exact head is the owner's merge approval (decisions item 97), with no open gate needed (TP-2078 a); not wired yet.
- 052a68e: The ci-red wake brief tells the fixer not to merge the base branch to re-run CI or to bring the PR up to date: Shepherd reruns flaky checks and merges the base itself at land time, so the fixer pushes only its fix. The conflict brief is unchanged.
- 6b0d06f: Shepherd records one observe-only `sh-head-origin` step for every head it did not make (`merge-of-base`, `merge-other`, `push` or `unknown`), read from the head commit's parents and a compare of its second parent against the base. `shepherd stats` counts the `merge-of-base` ones as `foreignMergeUps`.
- 0de505f: `shepherd stats` reports, per repo and ISO week, Shepherd's merge-ups by class (`landTime`, `strictChase`, `freezeHold`, `retry`), `strictRounds` (land-rules reads that found the repo strict), `slowOwnerGated` (slow merges whose wait held an owner `approve-merge` gate) and `foreignMergeUps` (0 until head origins are recorded), in `--json` and in the text line.
- d47c842: `shepherd register` now places the G10 hold itself when it starts a new run for a PR, recorded as a Shepherd hold event: `g10-adversary` for an authority, policy or security touch (a `security` kind counts), otherwise `g10-review` for over 400 changed lines, a file with no line counts, or a store migration (factory's `store-migrations.ts`, `*-migration*.ts`, `*-store.ts` and Shepherd's `store.ts`, `events.ts` and `train.ts` count as one). Shepherd's merge-policy files (`g10-*.ts`, `adversary-*.ts`, `merge-evidence-gate.ts`, `task-kind.ts`, `registration-hold.ts`) count as a policy touch. A file list Shepherd cannot read whole, from an API error or a list past GitHub's cap, fails closed to `g10-adversary`. The G10 hold stacks on any hold the run already has, so that hold gates again once the G10 hold is released; a `g10-review` hold over another class goes in as `g10-adversary`, since only an adversary hold keeps a second hold under it. The hold is a compare-and-swap retried on a fresh read of the run, so a hold placed while the file list is read stands under it. A repeat registration, or a restart whose events already carry a G10 hold, is left as it is. The register output names the hold.
- 15cf37a: Shepherd drops a carried conflict escalation once the head it would merge reads a mergeable state other than `dirty` or `unknown`, so the owner is no longer asked about a conflict that is gone (TP-2247 a).
- 5ce0d17: Shepherd now keeps a security run's owner approve-merge answer across its own clean merge-up of the base branch (TP-2252). The new head must be a two-parent merge whose first parent is the approved head and whose second parent is on the base, its tree must equal `git merge-tree` of the two, and the base side must touch none of the pull request's files; any other head asks the owner again. The `sh-approval-carry` step records the rule `own-merge-up` and its proof.
- c182337: Add a reader of the GitHub Actions checks green at a head for Shepherd's reviewer brief (TP-2277 a); not wired yet.
- 5de76d4: The Shepherd evidence comment for an allowed head now reads "Shepherd cleared to merge" instead of "Shepherd merged", because it is posted before the merge step runs. `evidenceComment(record, { mergeSha })` adds a `**Merged** at <sha7>` line after the headline for a caller that saw the merge land.
- c5e64dc: The deploy pacer has an express lane. A merge whose PR carries the `deploy:now` label skips the 15 minute quiet window and spawns the deployer on the next sweep. Busy runs, the deploy pause and a deployer already started still hold it, as they do for any other merge.
- 06506bc: serve shuts down in bounded time. On SIGTERM it halts every sweep, then releases its runs' leases before waiting on anything. Sweep ticks that are still running get at most `SHUTDOWN_SWEEP_GRACE_MS` (5 s) together. A tick still running at the end of the grace has its signal aborted, which kills the gate notifier's agent-chat child. Serve then closes the daemon and the database, and the serve verb exits the process. The `closed` log line carries the close time and any abandoned sweep, and the resync-at-start line carries `phaseMs`.
- c01010d: `titan-factory service check` reports a titan-factory.service that is activating, deactivating or waiting to auto-restart as cause `restarting` (exit 75, detail `activeState`, `subState`, `socket`) instead of `stale pid`, and reports a loaded but inactive titan-factory.socket as `socket down`.
- 4be0bcd: Shepherd resync: each PR read in the gone, head-moved, stale-review and stale-merge sweeps now times out after 20 s and counts as unreadable, so one hung read no longer stalls a whole phase; a dry run no longer reports a review or merge step that finished during its read.
- 59952a1: sh-fix-proof gates a fix/ PR registered by number, reading its head branch from the PR, and settles a head with no GitHub Actions run as missing after a 3-minute grace instead of the 25-minute deadline.
- 82d8c0a: Bind the sh-fix-proof run to the registered PR and base branch, so a run for another PR at the same head cannot supply the result (TP-2357 b). `CheckRun.pullRequests` is a new required field, so an external implementer of `GitHubWire` or a hand-built `CheckRun` must add it (an empty array when the run names no PR).
- 82d8c0a: sh-fix-proof trusts a result line only from a fix-proof run that concluded success on a PR that leaves the harness (workflows, actions, fix-proof.json, scripts/fix-proof-run.sh) alone; anything else is recorded as untrusted, so the reviewer brief gets no proof and a vacuous line cannot end the review as NO_REPRO. The newest fix-proof run at the head is always the one read.
- b0fb3e6: The Shepherd account wait releases the run's own hold only when the PR reads `closed`; any other or failed read keeps the hold (TP-2358 a).
- ac3de02: Split the CLI by command group: `land` registers from `cli-land.ts` and `resume`, `gate` and `serve` from `cli-host-verbs.ts`; no behaviour change.
- ace501c: Split the CLI by command group: the shepherd verbs register from `cli-shepherd.ts` and `postRpc` lives in `cli-shepherd-rpc.ts`; no behaviour change.
- d0e501f: A held Shepherd run's wait records the PR head it moved to, so `shepherd status` names the pushed head while CI runs at it.
- dc9ec0b: A held Shepherd run's seat notice says a pushed head runs CI and review while the hold stays, so no release is needed.
- 4bbe41d: Shepherd's head-moved supersede reads PR heads through the PR snapshot and calls GitHub for a PR only when its snapshot row differs from the gated head, cancelling only once that read confirms the move.
- e50502e: `titan-factory serve` supersedes head-bound gates whose PR head moved on its own 60 s head-moved sweep (`headMovedSweepMs`), instead of only on the 5 min merged-elsewhere sweep, so a failing merged-elsewhere read no longer skips it.
- 367a47c: Shepherd stores a settled park retry (migration 21, `shepherd_park_settled`) before it tells the seat, and a replay after a serve restart no longer re-arms a refusal that already settled at that head, so a dirty tree is reported once instead of once per restart.
- dfffc6c: Add the MRG-AU-RS allow row and its `verdict-merge-carried-merge-up-disjoint` condition: an automation merge may carry the dispatched reviewer's MERGE, for any kind including security, to a clean merge-up whose base side shares no case-folded path with the PR's changed files. `CarryFact` gains the optional `merge-up-disjoint` rule, `basePaths` and `firstParent`. Factory's mechanical MRG-AU gate reason reader accepts the new row's unmet clause.
- b94555c: Shepherd now holds a reviewer's account until its reset when the reviewer's `<synthetic>` usage-limit notice is read late or as the reply to its correction, not only on time (TP-2393). Such a round no longer becomes a timeout that spawns a fresh reviewer and counts toward the failed-rounds escalation.
- f4df76c: `shepherd stats --per-run` `reviewRounds` leaves out a head whose only rounds ended in a usage limit, whether the limit was read on time, late or as the correction reply.
- d5ddaba: Shepherd's fix-round wake brief carries every earlier FIX_FIRST of the run, each fenced with its defect class, from the 2nd FIX_FIRST on. When the current review names the same defect class as an earlier round, the brief requires one class-level, table-driven test corpus instead of another point patch (TP-2394 b).
- 0943d2d: `sh-fix-proof` waits 35 minutes by default, up from 25, so it covers the three-job fix-proof run: two 15-minute exec jobs, then the 8-minute judge job created only after they finish (TP-2406 d).
- c2d805b: Shepherd's merge guard reads the reviewer's `CI-policy:` line (TP-2407 b): `weakened` gates any PR on `shepherd-merge-guard/ci-policy-weakened`, a present but malformed or repeated line gates any PR on `shepherd-merge-guard/ci-policy-malformed`, and a `.github/` change with no line gates on `shepherd-merge-guard/github-path`. The line survives re-reads, carried MERGEs and external reviews.
- 567caaa: Add the `owner-asked` Shepherd hold class, kept in its own slot on the registration (migration 22, additive). The merge guard checks it before any satisfaction, so `sh-g10-release`, a `--reviewer` MERGE (at the head or carried to a tree-equal head), `release`, and a re-hold of another class all leave it in force. `shepherd release` refuses `--class owner-asked` and a bare release of a PR held by the owner alone; `shepherd hold` refuses an owner-asked hold with `--reviewer`. Only `ShepherdStore.releaseOwnerHold` lifts it. Cleanup of a PR merged around one records `owner hold bypassed: merged outside Shepherd`.
- 8ea5ba8: `shepherd register` on an open PR whose run ended abandoned now starts a new run at the current head instead of returning the dead run (TP-2415).
- d97ce5d: `service check`, `service status` and the deploy and rollback health waits probe `/health` with a 6 s per-request timeout instead of the daemon's 500 ms default, so a loaded serve is no longer reported as a stale pid or a failed restart. Each wait keeps its nominal wall-time budget.
- e22d2fd: Count runs per status without loading them (TP-2419). `WorkflowRunStore.countByStatus` reads the status index alone. Serve's `/health` counts through it instead of parsing every run's step results on each probe, which held the event loop for most of a second per request.
- cbc3107: Stop parsing every registered run on serve's hot paths (TP-2420). `WorkflowRunStore.statuses` reads each run's status without its step results, and `WorkflowRunStore.page` reads runs an id-ordered page at a time, optionally only those finished since a cutoff; the factory host exposes the store as `runs`. Shepherd's watch rows load only the runs a read wants: `list` by state, `status` by repo and PR, `waiting` the unfinished and gated runs, and the seat digest only finished runs their seat has not heard of. Pending gates are read once per call instead of once per registration. Those reads and the reverts sweep, which now pages the revert window's completed runs, yield the event loop every 10 ms.
- 4ba57bf: TP-2422: Shepherd's G10 registration hold now covers a branch registration when `sh-await-pr` finds its PR, and a repeat registration whose diff grew past 400 lines or into a stronger class. A weaker G10 hold, placed during the file read or inherited, no longer blocks escalation to `g10-adversary`. `release-head.ts` and Shepherd's `commands.ts`, `operator-hold.ts`, `seats.ts`, `release.ts` and `reviewer-choice.ts` count as policy paths, and a rename is classed by its old path as well as its new one. A hold history that cannot be read holds `g10-adversary`. `ReviewerFacts` gains `g10Hold`, so a run that holds or held a G10 hold gets the g10 reviewer.
- 5cda7c1: TP-2428: when Shepherd cannot read a run's hold history at registration, its fail-closed `g10-adversary` hold no longer replaces an adversary hold already in force, so a seat's hold keeps its reason and `--reviewer`. A new `ShepherdStore.holdUnlessAdversary` makes that check and the write one transaction.
- ccdb771: Shepherd's `sh-fix-proof` read fails closed on reads a head can force: a completed run with no result line for the head, a fix-proof run still incomplete at the deadline, and a missing run on a PR that touches the fix-proof harness (or whose changed files cannot be read in full) now read as `error` instead of `missing`. A new pure `fixProofStanding` maps an `error` result, an `untrusted` read and an `error` read to an unverified reason; reviewPhase wiring follows in TP-2434 c.
- 2fecffa: Shepherd sends a gated head whose fix-proof is unverified (an error verdict, an untrusted run, or an unread result) to the reviewer marked unverified, asks for the owner brief, and gives its MERGE no merge-on-green grant, so the merge waits at the owner gate even under an `auto` policy (TP-2434 c).
- 8f81511: Shepherd parks through the async `parkAgent` (TP-2435). `ParkPort`, the live-retry attempt and the fixer-retire park are async, so a park whose `agent-chat agent park` reads `titan-factory shepherd status` back from serve no longer blocks serve's event loop, starves lease renewal and replays `sh-park` on re-adoption.
- 7330b11: Shepherd's agent-chat adapters await the now-async spawn, resume, message and retire verbs, so serve no longer blocks on them, and a refused cleanup retire rejects instead of going unobserved.
- 2efc8a6: `titan-factory serve` logs an "event loop stalled" warning, with p99Ms and maxMs, for each 60 s window whose worst event-loop delay passes 5 s. A block that long starves workflow lease renewal, so the log now shows when one happened.
- 8dbc84e: The operator HOLD reader reads `agent-chat machine status` asynchronously and shares one in-flight read across a burst, and a structure test fails on any sync exec import in serve code outside the CLI, with `spawn-gate.ts` the one allowlisted file (TP-2436 b).
- c86b32e: Shepherd's local-git file read finds copies against every base file, so a fresh-name copy of a policy file is classed by its source and held `g10-adversary`; a diff whose copy detection git skipped fails closed to the unread-files hold (TP-2441 a).
- 407a6d7: Shepherd gates any head whose changed files touch `.claude/skills` with owner-only rule `shepherd-merge-guard/skill-path` (TP-2442 a).
- befbae7: The approve-merge brief at a head that changes repo skills names each skill path, links the pull request's files view, and drops the merge recommendation; an owner-gate seat's gate reason lists the skill paths too (TP-2442 b).
- 1b7d1cb: Shepherd never carries an owner merge approval to a later head at a skill-path gate, or when the carry proof's paths hold a repo skill path.
- 61fad4e: Shepherd gains `sh-no-reviewer-hold` and `sh-no-reviewer-wait` steps, not yet wired into the review phase. When the reviewer dispatch is refused, the hold step holds the run as `no-reviewer: <refusal> at <head>; TP-2446` and alerts the repo's seat once. If another hold is already in place, it leaves that hold alone and sends no alert. The wait resumes on release, head move, close or a 60-minute expiry. `noReviewerHeld` answers none with cause `not-started`, so a refused review is retried without counting a failed round.
- 325e3a0: Shepherd no longer counts a refused reviewer dispatch as a failed review round. When `sh-review` is refused for any reason other than a still-busy broker (for example `ReviewCheckoutUnusable` for a repo with no bound checkout), the run is held as `no-reviewer: <refusal> at <head>; TP-2446` and the seat is alerted once. The review is retried after a release or a head move, so three refusals no longer open a `failed-rounds` approve-merge gate on an unreviewed head. A refused step result now carries `refused: <failure class>`.
- d792cd0: Shepherd ci-wait re-reads the base's required contexts on every poll, so a context the ruleset dropped mid-wait no longer times the run out. An unreadable or newly empty live read keeps the list recorded at round start, and each snapshot records the contexts it judged.
- cd013c8: Key Shepherd's held check and held wait by round and head (`sh-held-check:r<round>:<sha>`), so a back-filled `{held:false}` memo from a restart replay can no longer answer a live ci-failed wake on a held run (TP-2452 a). A replay whose record goes on with the bare `sh-held-check` keeps the bare ids.
- 5b270f5: Shepherd: a ci-failed head whose every failing check also fails at the PR's base head wakes no fixer and spends no repair. The seat gets one `base-red` notice and the run waits in `sh-base-wait` until the base or the head moves, then refreshes the head and reads CI again. Unreadable base checks wake as before.
- 5446cc0: `service check` prints within a 20 s budget (`SERVICE_CHECK_BUDGET_MS`) across all its `/health` probes, and reports the new cause `unresponsive` when the launchd or systemd pid is alive but every probe timed out, with each probe's latency in `detail.probeLatenciesMs`. A dead pid, a foreign pid on the port or no process stays `stale pid`.
- 0d9399e: `service restart` and `service deploy` (rollback included) on Linux queue `systemctl --user restart --no-block`, wait 45 s for a new MainPID, then fence a main that ignores SIGTERM with `systemctl --user kill --signal=SIGKILL` and log `fenced pid N`; the /health wait starts once the new main exists (TP-2456 a).
- 3cb4a36: `service restart` and `service deploy` (rollback included) first clear a `titan-factory serve` that holds the service port from outside the unit or launchd job: identity is proven by its command line, cgroup or job pid and start time, then it gets SIGTERM, 15 s, a start-time re-check and SIGKILL, logged as `fenced pid N`. Any other holder is refused by pid and argv, and nothing is signalled (TP-2456 b).
- 652488d: On macOS, `service restart` and `service deploy` (rollback included) wait 45 s for a new launchd pid after `launchctl kickstart -k`, then SIGKILL the job through `launchctl kill SIGKILL` and log `fenced pid N`, as the systemd path already does. The rendered systemd unit sets `TimeoutStopSec=60`; run `titan-factory service install` once to rewrite an installed unit (TP-2456 c).
- 6f5b2cb: `shepherd status` shows a run the workflow runtime parked in `recovery_required` after it recorded `sh-landed` or `sh-stopped` in phase `done` with its outcome. The stall reason stays in `stalled.reason` and the text `[stalled: ...]` note, and `phaseSince`, `totalMinutes` and `stage` stop at the outcome step, so a merged run no longer reads as "in review" for days. A recovery run with no outcome, and a paused run watching main CI after its merge, keep their live phase.
- 0a8cc4f: Shepherd's freeze store records one seat-marked fix PR per freeze episode (`markFixPr`, migration 23), and `isFixersPr` lets that registered PR through the freeze; a new episode clears the mark (TP-2462 a).
- 22f5192: Shepherd spawns no fixer and opens no `main-frozen` gate while a seat's fix PR is marked for the freeze episode (TP-2462 b); a red while the mark is set goes to `main-red-again`, naming the PR.
- 414b9a4: The in-process command fallbacks (`localEnvelope`, the digest's local call) use `inProcessCaller`, so an unknown command name returns a usage envelope (code 64) instead of throwing.
- af96f70: Coordinator evidence judges main-green runs with `isPassingConclusion` from `@titan-design/github` instead of its own copy of the passing-conclusion set (TP-2465 e). Admissions are unchanged: success, neutral and skipped pass; cancelled, stale, failure and any unknown conclusion do not.
- cc37a2d: Move `ShepherdServices` and `SHEPHERD_WORKFLOW` to `shepherd/services.ts` so host and the sweeps stop importing the shepherd command registry (TP-2466 a); no behaviour change.
- 964415b: Import the reviewer port types (`ReviewerAgent`, `ReviewerReader`, `ReviewerDispatch`, `ReviewerMessage`, `ReviewTarget`, `AwaitVerdictInput`) from `@titan-design/review-panel` instead of through `shepherd/review.ts` (TP-2466 c); no behaviour change.
- fd3c51a: `service check` on Linux reports a failed `systemctl --user show` (no user bus, permission, timeout) as `unreadable` with systemctl's stderr, instead of `not loaded`.
- dfdb8ff: Shepherd no longer carries a security run's owner approval across its own merge-up when main's side touches a carry-fenced path (authority, tool-guard, workflows). A recorded own-merge-up answer with fenced or absent `mainPaths` asks the owner again (TP-2495 a).
- 8f48dcd: The agent-chat queue source sends `X-Titan-Client: titan-factory` on every broker request, so answering or dismissing an owner item is no longer refused with 403 by the broker's request guard.
- 588ba6f: Shepherd's fix-proof read no longer settles to `missing` while the `fix-proof-base`/`fix-proof-head` exec jobs exist at the head: it waits for the judge, and a judge still absent at the deadline reads `error` (TP-2520 a).
- f605422: Add `restackOnto` for Shepherd (TP-2528 b): the merge-onto commit a stacked child takes after its parent squash-lands, built with `merge-tree --merge-base` and `commit-tree`; it moves no ref and pushes nothing, and is not wired yet.
- 8a60a30: Add the review-stats store (`review-stats.sqlite3`: `review` table, `pr_review` view, `refreshed_through` watermark) and its incremental refresh from Shepherd's ledger and agent-chat retire rows, with a one-time transcript-priced fallback (TP-2529 b); not wired to a command yet.
- 23e28b7: Add `titan-factory shepherd stats --reviews [--from --to --repo --json --rows]`: refreshes `review-stats.sqlite3` and prints the v1 report of per-review cost, review and queue minutes (p50, p90, mean, total) by repo, ISO week, model and verdict, and per-PR rounds, cost and review minutes (TP-2529 c).
- ebc4fde: Shepherd's reviewer dispatch reports an agent-chat call that timed out (roster, spawn or resume) as `ReviewerAskTimedOut` instead of a raw `DispatchTimeoutError`, and adds `timedOutUnseen`, the not-started result for a timed-out ask whose reviewer never appeared (TP-2537 a). Routing is unchanged until slice b wires it.
- f788c21: Post-merge main CI makes fewer GitHub calls. Every live post-merge run on a repo now reads check runs through one shared per-repo ledger (`MainCiReads` in main-watch), so several runs on the same tip make one `checkRuns` per poll between them. `sh-main-ci` takes the base branch from the run's own merge, and `sh-cleanup` takes merged, head ref, head repo and merge sha from it. After Shepherd's own merge, neither step reads the PR. A PR merged outside the run, or a step recorded before these fields, still reads the PR as before.
- 878e0d9: Mark the read-only land and observe steps (`land-rules`, `ci-wait`, `base-check`, `sh-observe`) orphan-safe and pass the predicate to the runtime at register, so a restart's recovered read-only step that the replay never reaches no longer parks a run whose workflow returned.
- 6a13d77: Shepherd: add `isUnreadRegistrationHold`, `ShepherdStore.reclassIfHeld` and an adversary-rule exemption for an unread-files hold Shepherd re-classed (TP-2564 a); not wired yet. Migration 25 adds `shepherd_event.reclass`, the mark only the re-class release carries.
- 99fbfc8: Shepherd's fix-proof read no longer settles to `missing` when `.github/workflows/fix-proof.yml` exists at the PR's base ref (a head whose message carries a skip-ci marker, every run settled with no fix-proof run, or a deadline with no run): it reads `error`, as it does when the base branch or the workflow file cannot be read or the base branch is gone (TP-2572 a).
- 693b478: Register every factory workflow with `strictReplay` (TP-2574 b): a run adopted by a build whose call sequence diverged from the one that recorded it parks as `recovery_required` with `replay diverged` evidence, instead of running a gate such as `approve-merge` live where the original drive recorded nothing.
- 15c4c0b: Shepherd's verdict steps (`sh-await-verdict`, `sh-late-verdict`, `sh-seat-recheck`) record a verdict only if its author is the reviewer Shepherd dispatched, matched by agent and session. A verdict by anyone else, or a step input that names no dispatched reviewer, is recorded as no verdict. External mode, which starts no reviewer, is exempt.
- 88a7732: `parseReport` reads a `Proposed tasks:` block and sets `refused` for an item with no destination (`filed <id>`, `pending: <reason>`, or `dropped: <reason>` from `DROP_REASONS`), per decision 331 (TP-2603 c).
- 9f2ef60: Shepherd keeps its own reviewer's MERGE when a seat reviewer's WAIT, or a seat read that can clear, outlasts the seat-wait window. The next round at that head runs only the seat check again (`sh-seat-recheck`): it starts no reviewer and counts no failed round. Held rounds have a limit of their own: after six at one head, the owner's failed-rounds gate opens, naming the seat and its standing reason. A clear seat lets the MERGE go to the merge decision, a seat FIX_FIRST sends the head back, and a WAIT that still stands holds the MERGE again. Nothing merges until the seat check clears. A seat roster or transcript read that failed for a known-transient reason (a broker timeout, an unreachable or busy broker, or HTTP 5xx) is retried inside the seat-wait window instead of dropping the MERGE at once. A permission, missing-file or parse failure is not retried and blocks the head with no hold. A damaged transcript still blocks with no hold. While a seat holds the MERGE, `shepherd view` shows the hold as the PR's review wait.
- 028f110: A g10-review hold releases at a clean merge-up head whose CI reads behind with its own checks green, and the unreviewed-hold stall line counts a FIX_FIRST or a carried MERGE as a verdict (TP-2624 a).
- a44cc6b: Shepherd's await records why a no-verdict wait ended (`ended: deadline | reviewer-gone`) and which seat said WAIT (`seat`) (TP-2625 a).
- 711e95c: Name why the last review await ended with no verdict: `shepherd list` and `shepherd status` rows carry `lastNone` and print `last await: <reason>`, the g10-review stall line reads `no reviewer MERGE (last await: <reason>)`, and the digest's stuck line appends it (TP-2625 b).
- 8908ccf: Shepherd registration holds a `kind=security` PR with no sensitive path `g10-review`, not `g10-adversary`, and holds agent-chat's leak-guard, self-grant, permission-hook and host-directory paths `g10-adversary` (TP-2626 b).
- 0facd7d: Port the burndown leaf helpers the dispatch F2 and F3 slices both import into `src/dispatch` (TP-2627): report and slice lint, ops, owns fence, spend cap, review diff, and the leaf parts of plan, collision, observe, brief, trust gate and PR adoption; not wired yet.
- 608b103: `Commit` gains an optional `message`, which the gh adapter reads from the git commits API. Shepherd's ci-wait no longer waits out its 45 minutes on a head GitHub Actions started no run for: past a 5 minute grace, a conflicting head goes to the conflict fix round, and a skip token in the head commit message wakes the fixer to push a fresh commit. An unsettled mergeable state or a failed read keeps the wait as before.
- a1b8cde: A MERGE whose merge-on-green-approve grant is withheld records which half failed (`grantWithheld: { policy, proof }`, the proof half with the fix-proof read's reason). The MRG-AU gate reason, the evidence comment and the owner's why-asked sentence name it, so a bare `unmet: seat-grants-merge-on-green-approve` no longer reaches the owner (TP-2658).
- 24f0cf9: Shepherd: a carried fix-first-runaway, no-progress or conflict escalation no longer gates a head with a fresh dispatched-reviewer MERGE at that head under MRG-AU-RV; the decision records `shepherd-route/<escalation>/cleared-by-merge` (TP-2660 c, ac#823).
- a7ba1df: Shepherd no longer opens approve-merge when GitHub leaves `mergeable_state` unknown (TP-2660 e). Land re-reads with backoff for up to 20 minutes at the same head, then sends the repo's seat one `merge-unsettled` notice and keeps re-reading on each CI read. A new head starts its own wait. The owner gate opens only if the notice could not be sent.
- 5b1efb4: Shepherd's visual-path gate counts only files that can render (TP-2660 g). Tests and specs (`*.test.*`, `*.spec.*`), markdown (`*.md`) and type declarations (`*.d.ts`) under a seat's `visual_paths` no longer gate a merge. A rendering file beside them still gates, and the gate reason lists only that file. An empty or unread file list still counts as visual.
- afd4289: Shepherd's `asksOwnerBrief` now requires the round's fix-proof standing, and type tests pin that it and the seat recheck are always given one, since an empty standing reads as verified (TP-2661 a).
- 9502e62: `decideAutoMerge` takes optional `visualBaselines { check, paths }` (also on `MergeEvidenceInput`). A head whose changed files match `visualPaths` gates on `shepherd-merge-guard/visual-path` naming the baseline files when it adds, changes or removes a file under `paths`; with no baseline change and the named check at `success` from GitHub Actions at the head it clears, and the allow reason records the clearance. Any other check state, or no `visualBaselines`, keeps the glob gate (TP-2662 a).
- 0249e03: An autonomy-seat/v1 seat file may declare `visual_baselines: { check, paths }` beside `visual_paths`, and `Seat` carries it as `visualBaselines`. The seat book refuses it without `visual_paths`, with an empty `check`, or with a baseline glob that matches no repo-relative path (the message names `visual_baselines`). A remote several seats share keeps it only when every seat with visual paths declares the same check and paths. Nothing reads it yet (TP-2662).
- b32e619: Shepherd's seat-held approve-merge gate now reads "the seat held Shepherd's own MERGE for 6 rounds at one head" instead of "3 review rounds failed"; its rule id stays `shepherd-route/failed-rounds`, and the why-asked line uses the same words.
- 8438a4e: Read Actions job logs with `--allow-escape-sequences` and strip the colour codes, so `jobLogTail` stops failing with "HTTP 200" (TP-2665); `failureOf` no longer reports a 2xx as an HTTP error.
- 5f5dce9: review-panel: the adversary brief asks for a `Probes:` line above the verdict, and `acceptVerdict` refuses an adversary verdict without one as `probes_missing` (one correction, whose prompt restates the form; the correction cap rises to 1700 characters). `AwaitVerdictInput.shape` names the member awaited. `ShapeBriefInput.holdContext` puts a hold's reason, matched files, done-when and last report into the adversary brief, fenced as data. `ShapeRule.always` plans a shape whatever the files touch.

  factory: with `shepherd.gateReset.twoMergeRelease` set to `shadow` or `on`, a run held `g10-adversary:` gets Shepherd's own adversary member beside correctness, whatever `review.panel` says, at `review.adversaryProfile` (default `fable-reviewer`) and under `review.adversaryConfigDir` when set. Its brief carries the hold reason, and a verdict with no `Probes:` line gets one correction turn. Nothing releases on it yet. Absent or `off` changes nothing.

- c322ff8: factory: with `shepherd.gateReset.twoMergeRelease` set to `on`, a run held `g10-adversary:` releases with no seat when Shepherd's opus correctness MERGE and its adversary member's MERGE stand at the PR's current head, written there or carried by a recorded clean merge-up, with required CI green. The two must come from different sessions and different profiles. The hold stays if it names a reviewer, if the diff touches `packages/authority/src/table.json` (rename sources included), or if the file list cannot be read whole. The `sh-g10-release` step records the rule `g10-adversary/two-merge` and both verdict refs and profiles. The release event carries the head, so later heads must stay on its clean merge-up line. Under `shadow` the step records `wouldRelease` and releases nothing. A panel MERGE now records each member's verdict, head and spawn profile.
- 8073e98: Basement fixer briefs run dag:check once instead of dead:check plus dag:check.
- 651ce09: Shepherd's `takeVerdict` and `verdictOf` now require the round's fix-proof standing (and `takeVerdict` its account), so a caller can no longer drop `proofUnverified` from a MERGE by omitting it.
- 7390743: shepherd register restarts a run that strict replay parked as `replay diverged`: the registration (task, implementer, kind, holds) moves to a fresh run whose headSha is the old run's last read head unless the register names one, and the old run is cancelled as superseded. Closed pull requests and other recovery_required parks are left alone.
- 30a8373: The adoption sweep restarts replay-diverged Shepherd runs at serve start and on every lease tick: the registration moves to a fresh run as `shepherd register` does, and a diverged run whose pull request closed is cancelled. Branch-only registrations and other recovery_required parks are left alone.
- 21a5e6f: Add the Shepherd `test-only` kind, gated like correctness and inert: no run may move into it until `TEST_ONLY_GATED` is lifted (TP-2732 d). Add `testOnlyDiff`, a fail-closed classifier of a PR's diff by the base ref's fix-proof globs.
- ddaf75f: The Shepherd main-CI watcher reads a queued main run that a newer push superseded as superseded. Concurrency cancels such a run before any job starts, so the merge sha has no check run. Once main has moved past it, the watcher follows the newer push that contains the merge. A newer push still waiting behind the running main CI gets the queued re-checks, so it no longer opens a main-ci-timeout gate.
- 2f75ade: A wake brief for a red `dag-check` now names `lint:types` among the scripts to rerun, since CI runs the type-aware lint as a step of that job instead of a separate `lint-types` job.
- 51ce2b9: Shepherd reviewer stopgap (TP-2804). A reviewer ask that times out is looked for during the session-start wait and, if it is still unseen, retried on the next round rather than held through the 1 h no-reviewer wait. A reviewer that exits with no verdict at the head gets one correction turn in its own session, which names the Verdict, PR and Head lines. A fresh reviewer follows only if that resume fails.
- 84530cc: Shepherd accepts a g10-adversary release at the reviewed head when the PR's current head is Shepherd's own clean merge-up of it (TP-2826). The run's update-branch record must show Shepherd made the head, and a tree probe must prove it is a clean merge of the base into the reviewed head. The release event keeps the reviewed head, and the probe's proof is recorded as a vouch to the current head. A conflicted merge, an extra commit, a merge Shepherd did not make or a hold of another class still needs a release at the current head.
- 197064c: Shepherd no longer closes a sliced task when an unsliced PR merges (TP-2829). A task whose plan has a `burndown-slices` block, or that is tagged `epic`, gets a note naming its unlanded slices and stays open.
- 8c25894: Add `jobSteps(repo, jobId)` to `GitHubPort` (wire: `getJobSteps`): an Actions job's steps in run order, each with its name and conclusion. The fake answers from `fake.jobSteps` and 404s a job with none seeded.

  Shepherd's frozen-main and base-red holds now count a head's failing check as the base's only when it fails there at the same job step, and every failing test id (or, with no vitest heading, every error line) in the head's job log also fails there. A check that fails at another step, fails a test the base does not, or whose step or log cannot be read, wakes the fixer. So does one whose log may hold a failure it does not name: an unhandled error or worker crash, a tail cut inside vitest's failure output, headings that number other than the summary's failed tests and suites, or a step that timed out or was cancelled.

- d0017c5: Land checks the PR's base before the merge decision. A PR whose base is not the default branch (and whose run may not merge into a feature base) now waits at `base-wait` with no `merge-policy` step and no approve-merge gate; after a retarget it re-reads the rules and decides on the new base. Merge evidence read on another base is re-read before the decision (`LandOptions.evidenceBase`). Runs recorded before this replay without the new check.
- 1f7474f: Shepherd passes the base its MERGE evidence was read on (`evidenceBase`) to land. A stacked PR that GitHub retargets to main before land looks now has its evidence re-read on main, so a MERGE with green required contexts auto-merges under MRG-AU-RV instead of being judged on the parent branch's record.
- 3d780fd: Shepherd's head-moved sweep also cancels, as superseded with condition `base-changed`, a pending approve-merge gate whose named base differs from the PR's live base, or whose base is not the default branch on a run without the feature-base grant (`supersedeRebasedGates`). A Shepherd merge decision whose MERGE evidence was read on another base than the one land just checked gates instead of allowing.
- bdae82b: Deploy drain and watch (TP-2846). The restart drain no longer waits on a shepherd-pr run at `merge` behind another run on its repo's train, or on a run reading a seat's verdict (`sh-await-verdict`, `sh-late-verdict`, `sh-seat-recheck`). The 120 s watch judges run errors once, at the window's end, on the last two answers, against the drain's last pre-restart `/health`: a run the restart interrupted may stay recovery_required, but any new failed run, or a newly parked run that was idle at the restart, still rolls back. `/health` lists recovery_required run ids as `recoveryRequired`, and the deployer records the window's `{sha, windowEnd}` in `deploy-window.json`.
- a3fb3df: Shepherd: a seat reviewer's failed transcript read no longer blocks every PR on the machine.
  - A read that may clear, including the broker's "did not answer <frame>\_result" refusal, blocks with a retry, so the seat wait holds Shepherd's MERGE.
  - A read that fails the same every time clears with a warning only when the failing session's own complete records name a PR with another number (never a sibling session's, never a ref that may be this PR, and never for a hard failure), or the failing sessions' name stem or worktree is another registered PR's implementer or branch, read from Shepherd's registrations rather than from the shape of a path.
  - The read blocks when the reviewer's name or worktree is the PR's registered implementer's. With no evidence either way, it blocks with a retry, and the reason (kept when the seat wait holds the MERGE) names the reviewer and the evidence that was missing.
  - The seat-check reason carries agent-dispatch's own message, with credentials, URLs and home paths scrubbed and the length capped (TP-2872).
- bed3ea1: The seat check reads the agent-chat roster once and hands those rows to each seat transcript read, so a slow broker no longer multiplies `agent ls` calls. Rows without transcript fields still fall back to the reader's own roster. The text match for "broker did not answer" is removed; agent-dispatch now classes that reply timeout as `DispatchTimeoutError`.
- f1c9e3e: `redactCredentials` also scrubs npm tokens, `sk-` keys, three-segment JWTs and the `user:pass@` userinfo of any `scheme://` URL, so stored evidence and Shepherd reasons no longer carry them (TP-2877).
- 7eaf072: Seat roster rows may carry `transcriptExists`, and `awaitingTranscript` names a seat reviewer's newest row when it has no session or no transcript yet.
- 4c21b34: The seat check blocks, with a retry, on a seat reviewer the roster ties to this PR that has no transcript yet, so Shepherd's MERGE is held for it instead of landing before it can say FIX_FIRST (TP-2887 b).
- da06d0f: Shepherd no longer counts a refused `sh-review-intent` as a failed review round: a timed-out roster read is read again for the session-start window and then retried as not-started, and any other refusal holds the run as no-reviewer (TP-2966 a).
- 7875e10: A run recorded before TP-2966 a replays a refused `sh-review-intent` as the no-verdict it recorded instead of diverging into the no-reviewer hold step, so a deploy no longer parks in-flight runs as recovery_required (TP-3015).
- 9847b5f: Shepherd's base-side path lister (`changedPathsBetween`) is one shared helper that lists both sides of a rename, so a rename into or out of a carry-fenced path always meets the fence; the own-merge-up and remerge probes use it.
- 6b222d0: Reviewers no longer read CI with `gh api`, which reviewer sessions deny (TP-3050). `ReviewerBriefInput.ciChecks` carries the check-runs serve read at the reviewed head (name, status, conclusion, required) and replaces the test rule with a filtered table the reviewer judges CI from. Without it, `CI_REVIEWER_TEST_RULE` falls back to `gh pr view --json headRefOid,statusCheckRollup` and has the reviewer list `CI_UNREAD_LINE` when it cannot read CI at the head; `ciUnreadOnly` tells a FIX_FIRST whose only item is that line. `greenChecks`, which no caller set, is removed.

  Shepherd's reviewers get the new fallback rule through `suiteRules`.

- 0794c64: A FIX_FIRST from a reviewer Shepherd dispatched whose only blocking item is the CI-unread line now counts as no verdict (TP-3050). The same head goes to a fresh reviewer, no fixer is woken, and the failed-rounds cap still applies. A new `sh-ci-unread` step records the decision. A run recorded before the step existed replays its FIX_FIRST as it was taken, because its record goes on without the step.
- 8f56f6e: Shepherd's `sh-review` step reads CI at the reviewed head itself and puts it in the reviewer brief (TP-3050). `ciChecksAt` reads the PR's base, the required contexts the same way land reads them, and the head's check-runs. It returns the newest Actions run for each check name, the required contexts other apps post, and a `missing` row for each required context with no run. `shepherd/review` is left out. When any of those reads fails it returns no table, and the brief falls back to the reviewer reading `statusCheckRollup` itself. `greenChecksAt`, which had no caller, is replaced.
- e677787: `testOnlyDiff` refuses as unread a PR whose base is not the default branch. It reads `.github/fix-proof.json` at both the merge base of the default branch and the PR head and the default branch's tip, and calls a diff test-only only when both configs agree. A stacked parent branch, an old fork point that has wider globs, or one that predates the config can no longer loosen what counts as a test (TP-3057).
- d3eb096: A run recorded before the fix-proof cap existed replays its fix-proof wakes without diverging (TP-3067): when the record goes on without an `sh-wake-fix-proof` step, the replay neither records one nor counts it, so strict replay no longer parks the run in recovery.
- 5e23aed: Shepherd's approve-merge carry now judges the whole range from the approved head by tree equality with `git merge-tree` of the approved head and the base. A fixer commit after the approval, however small, asks the owner again (TP-3070); a pure merge-up still carries. The small-fix rule and `SMALL_FIX_LIMITS` are removed.
- db49b49: Shepherd: a route-table approve-merge gate the head moves past, failed-rounds included, carries its escalation to the new head, so the owner is asked there again and the cancel never stands as an answer. New hold class `owner-review` records a review the owner assigned to a person; no Shepherd MERGE releases it. A `g10-review` hold with no hold event on record, or an unreadable history, no longer releases itself.
- 9c0d7f7: The review packager's brief now points at the `titan-review` CLI: it runs `packet from-ci --clone <seat checkout>` once and first, follows `packet prompt`, never re-runs from-ci (it replaces the packet dir, `prose.json` with it), and finishes with `packet lint <dir> --gate-head <head> --require prose --clone <seat checkout>`, which must exit 0. The packager starts in the seat checkout. Every command names the binary by absolute path: new `shepherd.titanReviewBin`, default `$HOME/.local/bin/titan-review`. A head with no visual CI run, or a repo with no usable seat checkout, spawns no packager and records `visual-packet-spawn-failed` with the reason, in `shadow` as in `on` (TP-3196).
- 0bc8131: Shepherd: with `shepherd.gateReset.heldRepair: "on"`, a run held only under `g10-review` or `g10-adversary` wakes its fixer on ci-red, conflict, FIX_FIRST and NO_REPRO. The hold stays, so each new head is reviewed again and nothing merges while it is held (TP-3198). The flag is absent by default, which keeps today's wait. A MERGE at a green head now releases its g10-review hold before a conflict leaves the round. A seat notice that times out is sent again after a backoff.
- f793fc7: Add `checkAnswer`, the binding check a console Ship answer must pass before it resolves an approve-merge gate: the request's own gate, GitHub's head and tree, the packet hash and binding, and the owner's feedback must all name the same head.
- 21c5535: The console's Ship on a red head's `sh-visual-accept` gate resolves it as `accept-set`, carrying the approved set built from the factory's own packet for that head.
- a98941e: Shepherd can ask the owner, at a head red only on its seat's visual baseline check, whether CI's regenerated set is the one to commit, before any fixer is woken. Off unless `shepherd.visualSetCarry` is `shadow` or `on`; with it off a run records no new step.
- 8556b76: A pending `sh-visual-accept` gate is superseded by a push to the PR, and the visual packet trigger and delivery sweep treat it as a visual gate, so the owner's round for the red head reaches the console.
- cd42d7a: Add the `shepherd.visualDelivery` sweep: a finished visual packet is rounded, linted and, in `on`, imported into the console, with cancel checks on the live PR head before and after the lint.
- aa69748: `shepherd release --class g10-review` now accepts a PR whose head is Shepherd's own clean merge-up of the reviewed head, as a `g10-adversary` release already did. Land's update-branch merges main into a held PR whenever it reads behind, so every main move used to reset the review bar on g10-review holds. A merge no update-branch step of the run recorded, or one whose tree is not the clean merge-tree of the reviewed head and its base parent, is still refused.
- 35121c1: A red main that fails the same checks with the same failing tests as an earlier red now links to that red's standing fixer (still running, or with its fix PR open) and its fix task, instead of filing a new task and spawning another fixer.
- 83f3433: Shepherd retargets every open child of a landed stack parent onto the parent's base before cleanup deletes the parent's branch, whether or not the stack restack is on, and cleanup keeps the branch while any open PR is still based on it.
- ccf1c6e: A thaw no longer supersedes the approve-merge gate of a run with an owner-asked hold: the gate stays with the owner. Lifting or reclassing that hold queues the run's repo for the thaw sweep, so the gate is superseded then, and a later head moves it as before with the hold kept. A gate on a run with any other hold is still superseded on thaw, and the merge step waits on that hold, where its reviewer's verdict is read.
- 71887e9: A `g10-review` or `g10-adversary` release no longer refuses Shepherd's own land-time merge-up just because the release runs before the step has recorded it. GitHub shows the update-branch merge seconds before the `update-branch` step records the head as Shepherd's own. If the run's own update-branch step is still running, `shepherd release` now waits up to 60 seconds for that record, then reads the PR again and applies the same clean merge-up proof. If the step is still running after the wait, the release is refused with exit 75 and the caller retries. A head the step did not record as its own, a tree that is not the clean merge-tree, and a push that lands during the wait are all still refused.
- ca0dd12: `buildSpawnArgs`, `dispatchToAgentChat`, `buildResumeAgentArgs` and `resumeAgent` take an opt-in `launchedBy: "shepherd"` and optional `launchReason`, sent as `--launched-by shepherd [--launch-reason <text>]` (TP-3514, CC-1466). It is a roster record, never the `--spawned-as` gate input. A caller that does not opt in sends exactly the argv it sent before. Shepherd's spawns and resumes opt in; they need an agent-chat CLI that knows `--launched-by`.
- ca0dd12: `parkAgent(bin, name, timeoutMs, options?)` now requires its timeout, so no park call waits on the broker unbounded; pass `DEFAULT_PARK_TIMEOUT_MS` for the old default. `buildParkArgs` and `parkAgent` take an opt-in `{ noFixRoundCheck: true }`, sent as `--no-fix-round-check` (TP-3515, CC-1470); a caller that leaves it out sends the same argv as before. Shepherd's park step opts in, since agent-chat would otherwise call back into Shepherd to ask about a fix round; it needs an agent-chat CLI that knows the flag.
- 54d98e0: Add the Morning `DEPLOY HOLD:` item parser, a pure reconcile and sync onto the manual deploy hold, an optional `source` on `deploy-hold.json`, and `clearManualHold` (TP-3519 a); not wired into the pacer or `service deploy` yet.
- 9a58f91: A Morning `DEPLOY HOLD:` item now holds deploys: serve's deploy pacer syncs the manual hold from the seat queue files before each tick, and `service deploy` syncs it under `deploy.lock` before it reads the holds. Removing the item clears the hold after two ticks in a row find none; the failure pause is never touched. `DeployPorts` gains `listFiles`.
- faa55fe: Shepherd's fix-proof wake brief names the NO_REPRO reason, the merge base, the head branch and the carry globs read at the merge base, with the head branch, globs and result fenced (TP-545 a).
- 8a31c7f: Shepherd caps fix-proof bounces at two wakes per run (TP-545 b): each fix-proof wake records an `sh-wake-fix-proof` step before it is asked, and the third returns unhandled so the owner gate decides.
- f704deb: `titan-factory needs` maps chat_ask v2 meta onto the owner item (door, option descriptions, a label-only default, category, initiative, header, parked and reversible notes). A question with no declared door, or an unknown one, is now one-way (TP-695 b).
- 4f4db62: Read a `--reviewer` hold's named reviewer the way a seat reviewer is read: at any presence, `chat_send` verdicts counted, cached until the transcript changes. A live or detached reviewer's MERGE at the head now releases the hold with no `shepherd release` (TP-737 a).
- 6620d0b: Shepherd's post-merge cleanup now records who satisfied a hold in its release event (TP-737 b). `ShepherdStore.release` takes an optional event reason, and the cleanup release names its actor `shepherd:cleanup` and the merged head.
- 881f82e: Ledger replay regressions 18 and 19 (TP-737 c): a `--reviewer` hold placed after Shepherd's own MERGE at the head merges on the live named reviewer's `chat_send` MERGE with one dispatched reviewer and no gate, and stays held in the merge step with no gate while that reviewer sends no MERGE. Both sit outside the 17-gate set.
- 129f6d2: Shepherd keeps one FIX_FIRST count (TP-797): each FIX_FIRST round records `sh-wake-fix-first` before any hold or wake, and the runaway cap, the re-review brief and the wake text all read `fixFirstCount`. A held FIX_FIRST that woke no fixer no longer leaves the brief and wake a count behind the cap.
- 67bde18: `titan-factory serve` exits 0 beside a verified live factory; the launchd job restarts only on failure (`KeepAlive` `SuccessfulExit` false, `ThrottleInterval` 60) and the systemd unit uses `Restart=on-failure` (TP-811 a).
- 09aee81: Deploy liveness now uses `isProcessAlive` from `@titan-design/daemon`, so a pid of 0 or a negative or non-finite pid reads as dead instead of signalling the deploy's own process group.
- 6a7219b: Shepherd's cleanup records a short scrubbed message beside the class of a failed child retarget.
- fa23feb: TP-3340: Shepherd opens no visual accept offer at a step the old host left in flight, so a flag turned on between hosts cannot end an adopted run short of that step. The workflow context gains `recoveredInFlight()`.
- a811816: TP-3393: an adopting host whose old host left the visual accept offer itself in flight claims that offer and asks the owner, instead of skipping the offer for the whole drive. Another recovered step still holds the offer back.
- 31a7c73: A g10-adversary record from before the two-MERGE ask now replays as it ran instead of parking replay-diverged. The diverged sweep and a superseded restart end a parked run with steps in flight as cancelled at once, so adoption no longer replays it into a loop. `/health` lists `recoveryPrClosed`, and the deploy watch does not count those runs against a build.
- a72daee: Shepherd records a merge-train shadow at each land-time refresh: the peers a batch sealed at that moment would take (same repo, unheld, on the default branch, waiting on a refresh or the train), the waiting runs it would refuse and why, and a unit-level disjoint verdict between the PR and main's delta. The rows go to a new `shepherd_train_shadow` table (migration 26), and the update itself is unchanged. The shadow reads holds through its own check, which writes nothing: it never satisfies, withdraws or re-adds a hold, and reads a freeze without rechecking it. `shepherd stats` gains a `trainShadow` section with mean and max batch size, merges that landed outside the batch before the run's own merge, and the refresh-red rate.
- ec1036b: sh-wake-implementer: a wake whose asks the spawn gate only deferred now waits up to 30 minutes (`WAKE_DEFER_MS`), not the 5-minute ask deadline, so a finished implementer is resumed once the machine has room (TP-3238). A wake no agent took messages the session that spawned the implementer's lineage with the reason and whom to resume, and the step records that as `notice`.
- 093822f: A wait that a restart re-dispatches now resumes its deadline from the step's first start, so it gets only the time it had left. This covers ci-wait (with its backlog ceiling), sh-fix-proof, sh-late-verdict, and sh-review's session-start wait for a reviewer that was already asked for. `codeRoute` bodies now receive a `StepClock`, and a step with a restart counts as a repeat even at attempt 0.
- b0f35f6: The post-merge chore now runs in its own transient unit (`systemd-run --user`, or a detached process off Linux) and writes its result to `<stateDir>/chores`, so restarting serve no longer kills it. After a restart the post-merge route reconciles the step from those files. A finished chore is recorded and a running one is awaited. A chore that never started is retried. Only a chore that is gone and wrote no result parks the run.
- Updated dependencies [0dd6186]
- Updated dependencies [3189a46]
- Updated dependencies [6a0952d]
- Updated dependencies [108b7f4]
- Updated dependencies [9f24b7f]
- Updated dependencies [9ebb9ba]
- Updated dependencies [741313f]
- Updated dependencies [448bcea]
- Updated dependencies [8c89092]
- Updated dependencies [6281b49]
- Updated dependencies [cd013d1]
- Updated dependencies [089ac2c]
- Updated dependencies [cfc6614]
- Updated dependencies [54b6d69]
- Updated dependencies [7b9baf5]
- Updated dependencies [f171698]
- Updated dependencies [30c7ab5]
- Updated dependencies [65287ec]
- Updated dependencies [3fafd2e]
- Updated dependencies [8a027ad]
- Updated dependencies [9abae48]
- Updated dependencies [cf7c870]
- Updated dependencies [b0a3f7b]
- Updated dependencies [ed7042a]
- Updated dependencies [79754af]
- Updated dependencies [556b5e2]
- Updated dependencies [1476172]
- Updated dependencies [102a9df]
- Updated dependencies [be96d75]
- Updated dependencies [06506bc]
- Updated dependencies [a79cffd]
- Updated dependencies [8f37474]
- Updated dependencies [eae2dc4]
- Updated dependencies [2503c0c]
- Updated dependencies [82d8c0a]
- Updated dependencies [b0fb3e6]
- Updated dependencies [fe65aaa]
- Updated dependencies [91ea294]
- Updated dependencies [dfffc6c]
- Updated dependencies [ca49f58]
- Updated dependencies [2ea3f8a]
- Updated dependencies [3e94b0b]
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
- Updated dependencies [8f81511]
- Updated dependencies [7330b11]
- Updated dependencies [d754d5b]
- Updated dependencies [a914535]
- Updated dependencies [c278211]
- Updated dependencies [4ffd52a]
- Updated dependencies [ba8f25e]
- Updated dependencies [ba8f25e]
- Updated dependencies [15b5395]
- Updated dependencies [462e693]
- Updated dependencies [69f323c]
- Updated dependencies [c0bdde5]
- Updated dependencies [027f0f2]
- Updated dependencies [4ec603a]
- Updated dependencies [c4fc339]
- Updated dependencies [29e51f1]
- Updated dependencies [4dc300d]
- Updated dependencies [608b103]
- Updated dependencies [ac8bf42]
- Updated dependencies [8438a4e]
- Updated dependencies [5f5dce9]
- Updated dependencies [7a47bb3]
- Updated dependencies [7d93a92]
- Updated dependencies [edcb589]
- Updated dependencies [abadd64]
- Updated dependencies [abadd64]
- Updated dependencies [216db04]
- Updated dependencies [8c25894]
- Updated dependencies [0acca69]
- Updated dependencies [b6072b5]
- Updated dependencies [e6dafd1]
- Updated dependencies [d79a135]
- Updated dependencies [77e2c4d]
- Updated dependencies [6b222d0]
- Updated dependencies [1b2c974]
- Updated dependencies [ef109f3]
- Updated dependencies [6eab4e8]
- Updated dependencies [ca0dd12]
- Updated dependencies [ca0dd12]
- Updated dependencies [a2e2a70]
- Updated dependencies [dbc8a21]
- Updated dependencies [45d312c]
- Updated dependencies [ff27157]
- Updated dependencies [1c956dd]
- Updated dependencies [f03dea7]
- Updated dependencies [811e8ac]
- Updated dependencies [55cdd43]
- Updated dependencies [2467880]
- Updated dependencies [fa23feb]
- Updated dependencies [31a7c73]
- Updated dependencies [c50e702]
- Updated dependencies [2892aad]
- Updated dependencies [d79f48e]
  - @titan-design/github@0.11.0
  - @titan-design/agent-dispatch@0.8.0
  - @titan-design/agent@0.6.0
  - @titan-design/coordinator@0.5.0
  - @titan-design/daemon@0.7.0
  - @titan-design/review-panel@0.6.0
  - @titan-design/owner-queue@0.4.0
  - @titan-design/registry@0.5.0
  - @titan-design/workflow@0.13.0
  - @titan-design/session-analytics@0.17.0
  - @titan-design/authority@0.5.0
  - @titan-design/fix-proof@0.5.0
  - @titan-design/session-read@0.15.0
  - @titan-design/rpc-client@0.4.1
  - @titan-design/hitl@0.9.0
  - @titan-design/worktree@0.1.6

## 0.22.0

### Minor Changes

- 7a37aa8: `titan-factory shepherd status` takes `--active`, `--phase a,b`, `--branch-prefix p` and `--task id` filters, applied in the CLI so an older serve still filters.

### Patch Changes

- df69aad: Merge a Version Packages pull request only for a seat whose grants include `release-merge`. A seat with `merge-on-green-approve` alone now gates the release as `shepherd-release/no-release-grant`, because that merge publishes to npm. A seat without the grant no longer freezes the repo's other merges while its release waits.

  The release preflight also needs each package's latest npm version to name a trusted publisher (`_npmUser.trustedPublisher` with an `id`); provenance attestations alone do not count. A hand-published latest version blocks the release for the owner, because release.yml cannot publish without one. Registry reads now time out after 10 seconds.

- 9c426dd: `shepherd status` and the seat digest name a pending gate's own step (`approve-merge`) instead of an older `sh-fix-proof:<sha>` step the run's current step still pointed at, so the printed `gate resolve` command is stable and correct.
- Updated dependencies [61511e7]
  - @titan-design/github@0.10.0

## 0.21.0

### Minor Changes

- 5fd8ea4: Add `shepherd.repos`: a per-repo `path` the reviewer starts in when no seat binds the repo, and an `advisory` flag under which Shepherd reviews, watches CI and notifies but never merges, updates the branch, pushes, deletes the head ref, or spawns a successor or a red-main fixer. The flag fails closed when the config file is missing or invalid.
- a598a25: `titan-factory shepherd timeline` takes `--last <n>` (only the last n entries, noting how many earlier ones it cut; with `--json` it slices `entries`) and `--width <n>` (cut every text line to n characters). New `titan-factory shepherd wait <ref> --until <phase[,phase]> [--timeout s] [--interval s]` polls the PR's status row until it reaches one of those phases: exit 0 when it does, 1 when the run ends in another phase or the timeout passes, 2 on an unknown phase.
- 46339ef: Pace Shepherd's self-deploys. The `sh-redeploy` step now queues the merge sha in `deploy-wanted.json` instead of spawning a deployer per merge, and `serve` runs a 60 s deploy pacer sweep that spawns the deployer through the same systemd-run path once merges have been quiet for 15 min, or 90 min after the first queued merge. Busy review and merge runs hold the spawn until that cap, and a rollback pause (`deploy-pause.json`) holds it until cleared. A deployer that records nothing is asked once more after 2 h, then the sha is dropped until the next merge. `/health` gains `deployPending`.

### Patch Changes

- Updated dependencies [5985f32]
- Updated dependencies [cd830c1]
  - @titan-design/review-panel@0.5.4
  - @titan-design/github@0.9.0

## 0.20.0

### Minor Changes

- 4d15436: Add the `sh-release-follow` step: after a Version Packages merge it follows the release job on the merge sha, files one release-red fix task if the job fails, and polls npm until every bumped version resolves or it times out. The release preflight now records the bumped versions.
- 75937e6: `service deploy` watches a restarted build for a short window (`--watch-window`, `service.deployWatchMs`, default 2 min): serve must keep answering `/health` on the same sha and pid with no new failed runs. A failed restart, sha check or watch now rolls back, verifies the old sha is serving, pauses every deploy with `deploy-pause.json` (a newer sha does not bypass it) and files one incident notice to the hub seat and the owner queue. A rollback that does not verify raises one `ALERT:` and is never retried. `service pause` shows the pause and `service pause --clear` lifts it under the deploy lock.
- cc600f5: `shepherd register` infers a missing `--implementer` and `--task` from an `agent-chat/<name>` head branch, read from `--branch` or the pull request. A new registration without `--kind` stores `correctness`; a kindless repeat keeps the stored kind.

### Patch Changes

- 0e6074d: Shepherd asks the reviewer for an OWNER-BRIEF block when the run's policy carries `visualPaths`, as well as under `owner-gate`, so a `shepherd-merge-guard/visual-path` gate on an auto run has a brief to show. A MERGE verdict now carries the parsed owner brief, and the approve-merge gate at exactly that head shows it: the full block (what, why, pros, cons, door) in the gate prompt and a one-line form in the question the owner reads.
- Updated dependencies [3199c5a]
  - @titan-design/agent-dispatch@0.7.0

## 0.19.1

### Patch Changes

- Updated dependencies [de21f12]
- Updated dependencies [cd01cfa]
  - @titan-design/session-analytics@0.16.0

## 0.19.0

### Minor Changes

- 22a2d7b: Add the deploy pacer core: a wanted-deploy record and a pure pace decision that coalesce green factory merges into one deploy after a 15 min quiet window, capped at 90 min. Nothing calls it yet.
- 2239ef0: Shepherd runs a `sh-fix-proof` step before `sh-review` at every head. For a correctness or security run, or a `fix/` head branch, it waits for the head's `fix-proof` check run from GitHub Actions and reads the last `fix-proof/v1` line naming the head. A vacuous or test-less proof ends the review as `NO_REPRO` before any reviewer starts; a reproduced or unproven line reaches the reviewer brief. A missing check, a read error or another kind proceeds to review with the reason recorded.

### Patch Changes

- de97421: Re-deliver a Shepherd wake that was chat-sent to a live implementer once that agent exits without pushing a new head: the wake step runs once more in the same round, so the exited agent is resumed (or a successor started) with the wake as its prompt and the new head is awaited again. Resume and successor wakes are not re-delivered, a second exit takes the existing exit route, and FIX_FIRST is not counted twice.
- 2f90885: The restart drain treats an unanswered `/health` poll as unknown rather than idle: it keeps draining, and restarts a silent serve only after two minutes of consecutive no-answers (`NO_ANSWER_PROCEED_MS`). `wait: false` keeps its single check.
- Updated dependencies [b60d484]
- Updated dependencies [c54c098]
- Updated dependencies [7b9335c]
  - @titan-design/review-panel@0.5.3
  - @titan-design/agent@0.5.0
  - @titan-design/session-read@0.14.0
  - @titan-design/session-analytics@0.15.1
  - @titan-design/workflow@0.12.2

## 0.18.3

### Patch Changes

- 60d8aa5: `service deploy` no longer rebuilds or restarts for a merge whose changes inside the factory closure are only test files, markdown, or version-only `package.json` bumps (a Version Packages merge); it records `skipped` instead.
- 0891776: Shepherd's resync reads each run's PR with up to six reads in flight (`RESYNC_CONCURRENCY`) instead of one at a time, so a restart with dozens of live runs starts adopting in seconds. The gone-elsewhere sweep, moved-gate, stale-review and stale-merge supersedes read first, then act one run at a time in input order, re-reading each run or gate before acting as before; an unreadable PR still leaves its run held. `ResyncReport` gains `phaseMs`, the wall time of each phase.
- Updated dependencies [3977860]
- Updated dependencies [8bc0f25]
- Updated dependencies [ef240c0]
  - @titan-design/workflow@0.12.1
  - @titan-design/fix-proof@0.4.0
  - @titan-design/review-panel@0.5.2

## 0.18.2

### Patch Changes

- Updated dependencies [f640f72]
- Updated dependencies [ea3d34c]
- Updated dependencies [790401a]
- Updated dependencies [3ecb1c7]
  - @titan-design/session-analytics@0.15.0
  - @titan-design/agent@0.4.7
  - @titan-design/workflow@0.12.0
  - @titan-design/session-read@0.13.2

## 0.18.1

### Patch Changes

- 5b9d9f5: Wire Shepherd's machine-stop watch in production. `configuredRoutes` builds one watch over the factory's machine reading and spawn limits; the spawn gate notes every machine-stop breach it reads (not a pace or build-limit deferral), the reviewer dispatch notes every broker `machine_hold` refusal, and the review wiring carries the watch, so a reviewer that goes silent while the stop held is retried as a throttled round.
- d6e85ba: `shepherd status --json` rows carry the registration's `slice` (null for a whole-task run), and the `shepherd timeline` header line names the run's task and, when set, its slice, so a seat can confirm a sliced registration without reading `factory.sqlite3`.
- Updated dependencies [11df74d]
- Updated dependencies [662f42b]
- Updated dependencies [b924847]
  - @titan-design/session-analytics@0.14.0
  - @titan-design/session-read@0.13.1

## 0.18.0

### Minor Changes

- 97e40c3: `titan-factory shepherd stats --per-run --json` prints `{ perRun: [...] }`, one record per shepherd-pr run started in range: task, repo, pr, kind (from the registration, else `unknown`), status, start and completion, minutes per stage summed from the stage spans, review rounds as distinct verdict heads, and the merge time with its path (`shepherd`, `outside` or null). `--per-run` without `--json` exits 2.

### Patch Changes

- 34c1d15: End a Shepherd wake whose asks are only waited out (agent-chat timing out, the spawn gate deferring, the broker down) once `WAKE_ASK_MS`, 5 minutes, passes with the roster showing no effect, so the seat hears of it instead of the run waiting on an implementer that never resumes. A resume fallback the spawn gate defers past the same deadline fails too.
- 9e5af93: Retry a Shepherd review whose reviewer went silent while the machine stop held. A dispatched reviewer that times out now runs `sh-review-stop`, which asks the wired machine-stop watch whether a stop applied during the round or applies now, and waits for it to lift. A lifted stop records the round as `throttled`: the same head is reviewed again by a fresh reviewer and the round is not counted. Only the first throttled round at a run is exempt (`MAX_THROTTLED_ROUNDS`); later ones count as failed rounds, so a machine that never settles still reaches approve-merge. With no watch wired, or on a healthy machine, a silent reviewer is a timeout as before.
- 7c32fa8: Add the toolchain fanout core. It reads titan-platform's canonical `.node-version`, `packageManager` and `engines.node`, plans one adoption edit per consumer repo, and prints dry-run lines. An `actions/setup-node` literal `node-version:` becomes `node-version-file: .node-version`; matrix values, expressions and reusable-workflow inputs are left alone and listed. Nothing calls it yet; the serve sweep and CLI follow.
- Updated dependencies [dda3272]
  - @titan-design/workflow@0.11.0

## 0.17.1

### Patch Changes

- 546ff9c: Shepherd's ci-red wake brief for a failing `dag-check` job reads a wider log tail and quotes every dead:check NEW and GROWN line above the tail, so the implementer sees which exports to fix instead of only the `<n> new, <m> baselined` summary. `dead:check` now prints its NEW lines after the CARRY lines, next to the verdict.
  - @titan-design/session-analytics@0.13.3

## 0.17.0

### Minor Changes

- 20e426a: Add the Shepherd seat digest: `titan-factory serve` sends each seat one agent-chat message whenever its state changes, listing every open gate with its exact `titan-factory gate resolve` command, every `ci-failed` or `sh-sent-back` fix round the seat was told about with no fixer woken, and runs that finished since the last digest. An unchanged state sends nothing, and what each seat was last told is kept in `seat-digest.json` beside the factory database so a restart does not resend. The seat notice record now carries its gate and head.

### Patch Changes

- 452b194: Shepherd's main-red acknowledgement now judges a later main commit with `judgeMain` on `readMainRules`, the same path that greenAfterRed, unfreezeStep and readMainGreen use. A context pinned to a non-Actions app is judged by that app's runs, and classic protection contexts count as well.
- Updated dependencies [2b1640a]
- Updated dependencies [7c73654]
  - @titan-design/agent-dispatch@0.6.0
  - @titan-design/session-read@0.13.0
  - @titan-design/review-panel@0.5.1
  - @titan-design/session-analytics@0.13.2

## 0.16.1

### Patch Changes

- 77c1298: Open a gate naming sh-merge-evidence, instead of failing the run, when the merge-evidence comment post still answers an empty or unparseable body after its retries.
- Updated dependencies [3873ce6]
  - @titan-design/session-analytics@0.13.1

## 0.16.0

### Minor Changes

- 3d3cc58: Hold a Shepherd run as account-exhausted when its reviewer hits the account's usage limit, instead of re-spawning reviewers and falling to approve-merge. Only Claude Code's own `<synthetic>` limit record counts, never a reviewer's words. The run waits inside the review under the store hold (`account-exhausted: <configDir> until <reset>; TP-1955`), which is matched exactly so an owner's hold is never touched. The repo's seat gets one alert per exhaustion of an account. No reviewer is spawned on an exhausted account until its reset (believed only within 8 days, else re-checked after an hour) or an owner release, and the review runs again at the PR's current head when the hold lifts. The new optional `shepherd.review.fallbackConfigDirs` list moves the review to the next account with headroom. The restart drain does not wait on a held run.

### Patch Changes

- 9a842b3: The Shepherd ci-red wake counts the failing check runs and, for the known CI jobs (validate, lint-types, dag-check, egress-scan), names the scripts that reproduce each and asks the implementer to rerun them before pushing, as the brief's test rule says. Check-run names stay inside the fenced CI log and never reach the instruction text.
- 703c716: Cap a gate brief's evidence link at 500 characters so a long CI URL no longer makes the brief invalid, and say a carried MERGE was carried from a tree-equal head.
- 579886b: `PullRequest` now carries `autoMerge`, read from the REST `auto_merge` field. Shepherd's `shepherd/review` publish reads it, so a PR with auto-merge armed gets `action_required` rather than `success`; an unreadable PR is treated as armed.
- 4823243: Shepherd retires a main-red fixer and parks its clean pushed worktree once the red main is over; a dirty or unpushed tree and a fixer still running are left.
- 37fb5d0: On systemd, Shepherd's redeploy now starts `service deploy` in its own transient user unit (`systemd-run --user --collect`), so restarting the service no longer kills the deployer before it confirms health, records the outcome or rolls back. darwin keeps the setsid path. If systemd-run is missing or fails, the deployer falls back to setsid and logs why.
- d5fe1a2: Move the branch-holder lookup out of shepherd/commands.ts so the file fits the 350-loc dag-check limit; no behaviour change.
- Updated dependencies [579886b]
- Updated dependencies [587f2de]
- Updated dependencies [3d3cc58]
- Updated dependencies [3d3cc58]
  - @titan-design/github@0.8.0
  - @titan-design/session-analytics@0.13.0
  - @titan-design/review-panel@0.5.0
  - @titan-design/session-read@0.12.2

## 0.15.0

### Minor Changes

- eba2ac7: Add the read-only `factory.gates-review` command: each pending gate with its PR, head, policy rule, the reviewer's verdict at that head, the required checks, and whether it may ride in a batch.

### Patch Changes

- bd74657: Gate sweeps skip a gate another host settled between listing and cancelling instead of throwing partway through.
- eee55b5: Shepherd's errorClass now hides credential prefixes anywhere in an error name, in any case, and npm\_ tokens; consoleTextOf always returns a string; cleanup's retire refusals read through the safe text path.
- Updated dependencies [369a00b]
- Updated dependencies [1add3c6]
- Updated dependencies [bd74657]
  - @titan-design/github@0.7.1
  - @titan-design/review-panel@0.4.0
  - @titan-design/workflow@0.10.1

## 0.14.2

### Patch Changes

- 8dd6807: Land's flaky rerun now respects the ci-wait deadline, stamps a red with the time it was read, and waits only on the runs GitHub accepted a rerun for.
- 7fe216d: Every new `shepherd_event` row records its actor: the seat or owner name for a CLI hold or release, `owner` for a thaw from the owner gate, and `shepherd` for Shepherd's own holds, releases, freezes and thaws.
- Updated dependencies [be6e34c]
  - @titan-design/session-analytics@0.12.0

## 0.14.1

### Patch Changes

- 2ee3abf: Shepherd parks the worktree of each exited `rv-<owner>-<repo>-<pr>` reviewer at every green head, so finished review rounds no longer leave trees behind. A refusal is logged, sent to the seat, and retried at the next round end.

## 0.14.0

### Minor Changes

- 53685a5: Shepherd now keeps an owner's approve-merge `merge` answer across a small reviewed fix as well as a clean merge-up. A new head that is the approved head merged with its base plus a diff of at most 40 changed lines across at most 3 files, all already in the pull request, with no added, deleted, renamed or mode-changed file and no `.github`, lockfile or `package.json` dependency change, follows the answer when a reviewer said MERGE at exactly that head and required CI is green. The limits are the exported `SMALL_FIX_LIMITS`. The `sh-approval-carry` step records the rule and the tree or diff proof; any error computing the tree or diff asks the owner again.

### Patch Changes

- 2aeb12d: Add the Shepherd machine-stop watch: `stopReason` names a load5, memory pressure or free memory breach at the spawn gate's limits, `machineStopWatch` keeps an in-memory ledger of stops seen so a review round can ask whether one applied while it ran, and `awaitLift` polls until the stop clears or the hold ceiling passes. Nothing calls it yet; a later change counts a no-verdict review under a stop as throttled rather than failed.

## 0.13.2

### Patch Changes

- 0247ca2: Shepherd resync now ends a run whose PR was merged outside Shepherd even when the run recorded a merge step that landed nothing, such as one a g10 hold refused.

## 0.13.1

### Patch Changes

- 34da831: Shepherd's `sh-park` records a tree already off disk as parked, also tries the run's successors and the agent its `agent-chat/` branch was allocated to, retries a live agent once it exits, and tells the run's seat (or the hub seat) in one line about every tree it still leaves standing.

## 0.13.0

### Minor Changes

- 62bd19c: A `g10-adversary` hold that names a reviewer no longer takes that reviewer's verdict as Shepherd's review: Shepherd spawns its own reviewer at the head, and the named reviewer's MERGE only satisfies the hold. The new `titan-factory shepherd review owner/repo#N` asks for Shepherd's own fresh review at the PR's current head, once per head; a run waiting to merge at that head, held or not, sets its verdict aside, ends the land round so the policy or the owner decides again, and reviews again. A MERGE that stands for an asked head is never carried to a later head. Retries at an asked head stay Shepherd's own, a `g10-review` hold that names a reviewer no longer releases itself on Shepherd's own MERGE, and the Version Packages run refuses an ask. Migration 18 stores the ask on the registration.

## 0.12.2

### Patch Changes

- 2c83ae0: `titan-factory service check` reports a stale build only when the deploy checkout a restart loads is at a commit newer than the running build, so it no longer advises a restart that would roll serve back.
- Updated dependencies [15ede18]
  - @titan-design/session-read@0.12.1

## 0.12.1

### Patch Changes

- b3c0688: Shepherd no longer reruns a red head's failed jobs when it replays a run recorded before the hold check or the rerun existed, so a run that landed before a serve restart does not touch CI again. A rerun GitHub answers with "cannot be retried" or "already running" is recorded as not rerunnable and the run goes on to the normal wake instead of failing.
- 23b4922: Read the not-started review flag from `data.result`, where the sh-review step stores it, so the "review dispatches started no reviewer" stall fires on real runs. Rows with the flag at the top level still count.

## 0.12.0

### Minor Changes

- c6f753a: `service deploy` now fast-forwards and builds a dedicated checkout, `service.deployCheckout` or `<app data dir>/deploy/titan-platform`, that no agent or coordinator uses as its cwd. An absent checkout is cloned from `service.deployRemote` (default: the CLI checkout's origin), built, and left for `service install`. While the installed unit does not start the deploy checkout's bin, deploy only builds and never restarts. `service install` renders the unit to run serve from it with `WorkingDirectory` set. `service install` refuses until the deploy checkout has a built bin. One-time migration: run `service deploy`, then `service install`.
- cbc8192: Add the `device-pr` workflow (pilot 3): land-pr whose approval is a `device-confirm` gate. The owner performs the device step named by the `deviceStep` param and answers pass, fail or abandon at the exact head, from the terminal at the device. A fail reads as a red head, so the ci-failed gate decides what follows, and a new head asks the device again. The factory never talks to a device.
- 08d99ea: Read the owner-queue directory from `digest.queuesDir` (now also read by the owner-queue reader) and the service label prefix from `service.labelPrefix` in the factory config. Both default to today's values.
- 58265b2: `titan-factory shepherd stats --cost` reports reviewer dollars and tokens (input, cache read, cache write, output) per merged PR, per repo and ISO week, and in total with p50 and p90 per merged PR. Every dispatched review round counts, from its review intent to the step that resolved it (an on-time, corrected or late verdict, or a timeout); it reads the transcript the round's verdict locator names, read-only, and prices it with `@titan-design/session-analytics` `priceRequest`. A round that cannot be priced is listed as unreadable with its reason and never counted as zero.
- 7b6c839: Shepherd's spawn gate defers a reviewer while `shepherd.review.maxConcurrent` (default 3) reviewers run, or while the filesystem that holds review checkouts has fewer free bytes than `shepherd.review.minFreeBytes` (default 5 GiB) or fewer free inodes than `shepherd.review.minFreeInodesPct` (default 15) percent of its total or twice the last checkout's, whichever is more. The deferral is logged with the reading and keeps the review's place in the oldest-first queue.
- 36c876d: `titan-factory shepherd stats --slo` evaluates the checkout's `metrics/shepherd.yml` (or `--registry <file>`): for each metric it prints the value over the SLO's window (or `--from`/`--to`), the SLO, and `pass`, `fail`, `no-data`, `no-slo`, `no-query` with the metric's gap slice, or `error`; `--json` returns `{ "slo": [...] }`. A registry query names one of the stats SLO queries by id; a window with nothing to measure reports `no-data`, never a zero.
- c0701a9: `GitHubPort.defaultBranch(repo)` reads the repo's default branch, and `GitHubPort.merge` takes an optional `expectedBase`: a PR on another base skips as `base-changed`, checked before the write and before each retry. The land core now records a `base-check` before every merge. An approved head whose pull request is based on anything but the default branch waits in `base-wait`, with no timeout, until the pull request is retargeted; a Shepherd run gives its repo's merge train up before it waits. An approval or policy allow covers one base: after a retarget the run re-reads the merge evidence and decides again, the `approve-merge` prompt names the base, and an approval never follows to a head on another base. A green read that names a new base re-reads the branch rules. A seat's `merge-into-feature-base` grant lets its runs merge into a stacked pull request's own base. `shepherd status` names the refused base as the next action.
- ee5a12e: Shepherd reruns a red PR head's failed Actions jobs once before it wakes the implementer. A check that passes on the rerun wakes no one; one that fails again wakes the implementer once, at the second run. A head gets one rerun in total, shared with the rerun after a fixer exits without pushing, and a replay after a restart rebuilds the count.
- be222f1: Shepherd watches main CI after every merge, its own or a seat's: serve reads each seat repo's main every 5 minutes, stays silent on green, and sends one red event per sha (failing jobs and sha) to the owning seat, with the hub seat as the fallback. A ledger beside the factory database keeps the event single across restarts.
- 91eea82: Pass the formatted squash message on every land merge. `GitHubPort.merge` takes an optional `{ subject, body }` that the wire sends as `commit_title` and `commit_message`; the port gains `getSquashSource` (title, body and commit messages) so a caller can build the `formatSquashMessage` input. The factory's land merge step formats the PR's title, body and commits with the run's task id and merges with that message, falling back to the plain title and an empty body (and a warning) when formatting throws.
- 7c4fc10: Each `shepherd status --json` row now carries `implementer` (the registration's, or null) and `reviewer` (the agent name the newest started `sh-review` dispatched, or null), so consumers no longer guess the agents from the branch.
- 446c60a: Move Shepherd review checkouts to the titan-factory app data dir. `reviewerBrief` now requires `checkoutRoot`, puts the head and base checkouts under `<checkoutRoot>/<run>`, and tells the reviewer to remove that whole dir. Shepherd also removes the run dir when the verdict step ends, and the stale-checkout sweep reads the same root.
- dc48dfc: A standing deploy alarm no longer goes unheard. serve logs a warning at start, and `service check` fails with `no hub seat`, when `shepherd.hubSeat` is not set. The hub seat is told again every `shepherd.deployAlarm.renotifyTicks` deploy-watch ticks (default 6) while the alarm stays up, and once it has stood for `shepherd.deployAlarm.escalateAfterMinutes` (default 30) serve files one owner-queue item into the titan console's deposit spool.

### Patch Changes

- 1b0b826: A repeat-safe workflow step that fails with a GitHub server-side error (`gh-api-5xx`) is retried up to three times, after 5 s, 20 s and 60 s, before the run fails. The retries are recorded as `ghRetries` on the step's evidence record, and any other failure class fails at once.
- ba9e766: Lead Shepherd's merge-evidence comment with a readable summary: a one-line outcome, a table of the check runs and the reviewer verdict, and for a gate the rule in words with the paths as a list. The full JSON record is unchanged and sits inside a collapsed "Machine evidence" block after the marker.
- ffd8d4d: Shepherd never wakes a fixer on a held run. A ci-red repair, a FIX_FIRST send-back or a conflict on a held run spends no repair and starts no agent; the run's seat (its policy seat, else `shepherd.hubSeat`) gets one notice per hold, head and cause, and the run waits. On release the normal repair path resumes at the same head.
- 29b8cca: On basement, the Shepherd reviewer brief now says never to install dependencies in the review checkout, and to run targeted tests with `basement-suite <repo> <branch> --agent <name> -- <paths>`. A titan-platform review checkout drops from about 102k inodes to about 3k.
- 516b095: Shepherd now supersedes a pending `shepherd-route` `fix-first-runaway`, `no-progress` or `conflict` approve-merge gate when the pull request head moves past the gated head, in the serve sweep and in resync. The new head is reviewed, and the owner is asked again there with the gate naming the carried reason and the new review; the superseded gate is cancelled, never answered, and its reason gates every later head until the owner answers an approve-merge gate, so even an `auto` policy does not merge the new head on its own.
- e4dd79b: `land-rules` no longer fails every run on a private free-plan repo (TP-1899). When the rules read answers HTTP 403 "Upgrade to GitHub Pro" and the branch endpoint reports `protected: false`, the base reads as requiring no checks, so `ci-wait` requires every check-run at the head to be green. Any other 403, a `protected: true` or an unreadable branch still refuses. `@titan-design/github` gains `branchProtected` on the port and `getBranchProtected` on the wire.
- Updated dependencies [3bf2ac3]
- Updated dependencies [4a42590]
- Updated dependencies [b7c53ee]
- Updated dependencies [9c173c9]
- Updated dependencies [c174b71]
- Updated dependencies [d7102a6]
- Updated dependencies [c0701a9]
- Updated dependencies [91eea82]
- Updated dependencies [73683d7]
- Updated dependencies [e4dd79b]
- Updated dependencies [7d52415]
- Updated dependencies [446c60a]
- Updated dependencies [845a0cf]
- Updated dependencies [5c659a3]
- Updated dependencies [dcf8e04]
  - @titan-design/session-read@0.12.0
  - @titan-design/session-analytics@0.11.0
  - @titan-design/owner-queue@0.3.0
  - @titan-design/review-panel@0.3.0
  - @titan-design/github@0.7.0

## 0.11.0

### Minor Changes

- c3792ba: Add the doc pilot's task source, claude-print draft route and pure draft check. The task source reads a docs task's title, done_when and status over the active-work rpc and never its notes. The draft route runs one sonnet turn through an injected agent runner and parses the reply with zod. `checkDraft` refuses unchanged content, a non-Markdown path, front-matter edits, a removed section, owner data in an added line and a line delta over the bound.
- 9a3682b: Add `titan-factory shepherd coverage`: prints the Shepherd coverage report for the four charter seats over the 24 h ending now (`--end`, `--hours`, `--seat`, `--logs` move it), from a read-only ledger. `--min <share>` exits 1 when the total share is below the bar; `--json` prints the report.
- 04058da: Add the Shepherd coverage fold: `coverage()` counts each seat's `merged` dispatch rows in a window once per PR and reports, per seat and in total, how many a completed Shepherd run merged. The report also lists the misses and the held runs whose reason is not a charter hold class. `readCoverage()` reads the seat logs and opens the factory ledger read-only. `mergedAt` is now exported from the shepherd stats module.
- 1a1bdeb: Add the `measurement-audit` workflow and `titan-factory audit <area>`. The workflow inventories an area's stores and code, proposes metrics in the six families and baselines them read-only. It ranks the capture gaps as slices and writes a `titan.measurement-audit/v1` report to the required `--out` path once the area owner publishes it at the review gate.

### Patch Changes

- 619dc1e: Import `acceptVerdict`, the owner-brief parser, the Malformed refusals, `namesTarget` and the depth floor from `@titan-design/review-panel` and delete the local copies.
- dc635a8: Shepherd's reviewer and fixer briefs now take their test rule from the host serve starts on: on basement they say to call `basement-suite` directly, never through ssh, and elsewhere they keep the `ssh basement basement-suite` form.
- Updated dependencies [948d6de]
- Updated dependencies [875eee0]
- Updated dependencies [700f490]
- Updated dependencies [9e29d34]
- Updated dependencies [c754254]
- Updated dependencies [619dc1e]
- Updated dependencies [948d6de]
- Updated dependencies [dc635a8]
- Updated dependencies [1893149]
- Updated dependencies [718eda8]
- Updated dependencies [718eda8]
- Updated dependencies [84bd62f]
  - @titan-design/daemon@0.6.0
  - @titan-design/health@0.2.0
  - @titan-design/owner-queue@0.2.0
  - @titan-design/review-panel@0.2.0
  - @titan-design/rpc-client@0.4.0
  - @titan-design/registry@0.4.0
  - @titan-design/session-read@0.11.1

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
