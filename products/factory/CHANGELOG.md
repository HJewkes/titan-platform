# @titan-design/factory

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
