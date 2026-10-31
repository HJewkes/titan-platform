# @titan-design/agent-dispatch

A client for agent-chat's supported programmatic surface, the `agent-chat` CLI. It starts
an agent under a named profile with the brief on stdin (never in argv, which `ps` shows to
every local process), builds the argv that resumes an ended agent's Claude Code session
with one more message, and runs binaries by absolute path with a minimal environment.

Tier 1 of the titan-platform DAG, with no titan dependencies (zod is a peer dependency,
used by `readAnswers` and the `./limits` subpath). Ported unchanged from relay's
`daemon/src/dispatch.ts`, `exec.ts` and `session.ts` (`resumeArgs`) by TP-460. relay's
daemon now depends on this package and its own copy is deleted.

```ts
import { dispatchToAgentChat, resumeArgs, execSafe, minimalEnv } from "@titan-design/agent-dispatch";

await dispatchToAgentChat(
  { agentChatBinPath: "/opt/homebrew/bin/agent-chat", peerName: "item-42", profile: "headless-implementer", brief, cwd },
  15_000,
  ["headless-implementer", "headless-reviewer"],
);
```

- `dispatchToAgentChat(req, timeoutMs, allowedProfiles)` refuses a profile outside the
  caller's allowlist and a peer name outside agent-chat's name shape, then refuses a
  profile whose installed file is not headless (`assertInstalledHeadless`), then runs
  `agent-chat agent spawn <name> <profile> [--briefing <slug>] --brief-stdin`. A zero exit
  means the broker accepted the spawn, not that the work is done. A non-zero exit rejects
  with `DispatchError` carrying the CLI's stdout reason, else its stderr; a CLI that hangs
  rejects with `DispatchTimeoutError`, since the spawn may still have happened. So does a
  stderr line `broker did not answer <frame>_result` (the broker missed its reply window,
  and the frame may have landed), on this and every other verb here. It runs the
  CLI in `req.cwd`, which agent-chat sends to the broker as the spawn location.
- `assertInstalledHeadless(profile, dir?)` reads `<dir>/<profile>.json` (default
  `installedProfilesDir()`: `$AGENT_CHAT_HOME/profiles`, else `$HOME/.agent-chat/profiles`)
  and throws `DispatchError` unless it says `"surface": "headless"`: an interactive surface
  puts the brief in `claude`'s argv. A missing, unreadable or non-JSON file is refused too,
  and so is a profile name outside `^[a-z0-9][a-z0-9._-]*$`, before any path is built. The refusal names the profile and
  path, never the file's contents. `dispatchToAgentChat` takes `profilesDir` to point it
  elsewhere. The broker re-reads the file after this check, so a write in between is still
  possible until agent-chat's surface lock closes that window.
- `agentChatEnv()` is the env every agent-chat CLI call runs under. It forwards a non-empty
  `AGENT_CHAT_HOME`, so the CLI reaches the broker whose profiles the guard read.
- `dispatchToAgentChat` also takes `configDir`, passed as `--config-dir <path>` to run the
  agent on another Claude account.
- `dispatchToAgentChat` and `resumeAgent` take an opt-in `launchedBy: "shepherd"` (and an
  optional `launchReason`), sent as `--launched-by shepherd [--launch-reason <text>]` so the
  agent's roster row records who started it. It is a record, not the `--spawned-as` gate
  input. A caller that leaves it out sends the same argv as before.
- `resumeAgent(bin, name, message, timeoutMs, launch?)` runs `agent-chat agent resume <name>
  --message <message>`, so the broker tracks the resumed session. It refuses a name outside
  agent-chat's name shape before running anything, and rejects with `DispatchError` on the
  broker's refusal. The message is in argv.
- `parkAgent(bin, name, timeoutMs, options?)` runs `agent-chat agent park <name>`: the broker removes
  an exited agent's clean, pushed worktree and keeps its branch, and `resumeAgent`
  re-creates it. A refusal (live, dirty, unpushed or shared tree) rejects with `DispatchError`
  carrying the broker's reason; a broker that cannot be reached rejects with
  `BrokerUnavailableError`. It is async: `agent park` may read the caller back (agent-chat asks
  Shepherd about a fix round), so a caller that serves HTTP must keep its event loop free.
  The timeout is required (`DEFAULT_PARK_TIMEOUT_MS` is 60 s). Shepherd passes
  `{ noFixRoundCheck: true }` for `--no-fix-round-check`, so agent-chat does not ask it back;
  any other caller leaves it out and gets the same argv as before.
- `messageAgent(bin, name, text, timeoutMs, options?)` runs `agent-chat debug send -- <name> <text>`:
  the broker delivers the text to a live agent as one channel message from the human seat,
  which starts a turn in an idle session. A name with no live session rejects with
  `DispatchError` carrying the broker's reason. The text is in argv. Pass
  `{ source: "console" }` (or `"watchdog"`, `"shepherd"`) for `--source`, so the message
  arrives labelled `wake_source=<source>` without human provenance; a caller that leaves it
  out gets the same argv as before.
- `dataFence(label, text)` wraps untrusted text in a fence one backtick longer than the
  longest backtick run in it (at least three), preceded by a line saying it is data.
- `lastFencedJson(text)` parses the body of the last ```` ```json ```` block in an agent's
  final message, the way an implementer ends its report; undefined when there is none, and
  a `SyntaxError` when the block is not JSON, so a malformed report never reads as missing.
- `dispatchToAgentChat` and `buildSpawnArgs` take an optional `role` (`implementer`,
  `reviewer`, `fix-round-<n>` and the rest of agent-chat's `--role` values) and `task`, sent
  as `--role` and `--task` so the agent's roster row records who it works for. A task id
  outside `TASK_ID_PATTERN` throws `DispatchError` before anything runs; a caller that leaves
  both out gets the same argv as before.
- Every agent-chat call runs with `AGENT_CHAT_NO_AUTOSTART=1`. When the CLI reports that it
  cannot reach the broker, the call rejects with `BrokerUnavailableError` (a
  `DispatchError`); every other refusal stays a plain `DispatchError`. Every verb that runs
  the CLI is async, so a caller that serves HTTP keeps its event loop free while a slow
  child answers.
- `resumeArgs(sessionId, message)` returns `claude` argv; run it with `execSafe`. The
  message is in argv here, so callers decide what may go in it.
- `listAgents(bin, timeoutMs)` reads `agent-chat agent ls --json` and returns typed
  `AgentRow`s, skipping a row whose required field is missing or mistyped and dropping an
  optional field (`model`, `transcriptPath`, `transcriptExists`, `spawnedBy`, `account`,
  `teleportFrom`) that has the wrong type. `retire(bin, name,
  timeoutMs, { force })` frees a name and returns the broker's caveats. Both reject with
  `DispatchError`, or `DispatchTimeoutError` when the CLI hangs, since a hung retire may
  still have happened.
- `askHuman(bin, { as, text, task?, options?, recommended? }, timeoutMs)` puts a question on
  agent-chat's human queue for a process that is not a Claude session, under the service
  label `as`, and returns its msg_id. It runs `agent-chat ask --as <label> --text-stdin
  --json`, with the text on stdin. `readAnswers(bin, label, since, timeoutMs)` reads the
  answers and dismissals to that label's asks after the msg_id `since`, oldest first, as
  `{ answers: ServiceAnswer[], next? }`; pass `next` back as `since`. A body that is not
  that shape throws rather than reading as an empty page. `dismissAsk(bin, msgId,
  timeoutMs)` withdraws an ask, and throws `DispatchError` when it is already closed. All
  three throw `BrokerUnavailableError` when the broker is down or predates the verbs (exit
  69), and a `DispatchError` naming a usage error on exit 2.
- `execSafe`, `execSafeAsync`, `minimalEnv` and `resolveBinaryPath` never use `PATH` lookup
  or `process.env`, and never a shell. `execSafeAsync(bin, args, env, timeoutMs, input?,
  cwd?)` is the non-blocking form; `input` and `cwd` are opt-in.
- `observeAgentChatCalls(report, { now? })` reports `{ verb, ms, outcome }` for every
  agent-chat call this package makes, spawn included, and returns the unsubscribe. The verb
  is `agent <sub>` or the first argv word, so no peer name or briefing is ever reported.
  `outcome` is `ok`, `refused` (non-zero exit), `timeout` or `error`. An observer that
  throws is ignored, and nothing is timed while no observer is registered.
- `bootPacket({ task, plan?, repo, touchPoints?, readers, options? })` builds an
  implementer's first-turn packet: git state labelled with its capture time, the task card,
  the plan slice's excerpt, ±15-line excerpts of up to 8 touch points (by default the
  backticked paths in the slice) and readiness (install command, scripts, CAPABILITIES
  rows). Each section has a token cap, and the packet a 6k-token budget; over budget,
  whole sections drop from the end of `options.priority`. A source that cannot be read
  leaves its section out and is listed in `omitted`, never thrown. Every read goes through
  the injected `BootReaders`; `nodeBootReaders({ repoRoot, gitBin, readTask })` reads a
  local checkout, and the caller maps its task store (for example `@titan-design/pm`) to a
  `TaskCard`.

Profile names, peer-name derivation and profile installation are the caller's policy and
are not in this package.

## Limits (`./limits`, `./limits/node`)

The per-pool and per-profile spend limits the budget gate reads: one versioned `limits`
block with `defaults`, `pools`, `funds`, `profiles`, `seats` and time-boxed `overrides`.

- `limitsSchema` validates a whole block; `parseLimits(raw)` splits it by scope so a
  malformed pool, profile or seat closes only itself and a malformed override is ignored.
  An unusable envelope throws `LimitsConfigError`.
- `resolveLimits(parsed, { pool, profile?, seat?, now, grants?, answeredQuestions?,
  fiveHourResetsAt? })` folds code defaults, `defaults`, the pool, the profile, the
  profile × pool entry, active overrides and answered grants, field by field, then clamps.
  It returns the source layer of every field. A seat cap only tightens.
- `checkLimits(parsed, { now, knownConfigDirs?, knownProfiles? })` reports expired
  overrides, closed scopes, unknown pools, profiles and config dirs, and clamps.
- `liftQuestion` and `grantFromAnswer` are the pure halves of the owner's time-boxed lift.
- `loadLimits(path, { key? })` and `readGrants(path)` from `./limits/node` read files the
  caller names; the package owns no path.
- `limitsReport(plan, ledger, clock)` projects a planner's dry-run result (a structural
  `LimitsPlanInput`), the claim ledger and a Shepherd read onto the v1 `/limits` report;
  `limitsReportSchema` validates it. It reads no config, so its counts match the tick's.

## Isolation (`./isolation`)

The isolation strategies a spawn picks from its profile, and the rules that keep a retire
or a park from removing a tree another agent works in.

- `createIsolationRegistry({ worktree })` gives `getStrategy(name)` and `resolve(names)`.
  The host builds the worktree strategy, since it reads host budgets; `resolve` layers
  several names through `composite`, which narrows tools, keeps the last moved cwd and
  force-releases earlier members when a later allocation throws.
- `noneStrategy`, `toolsetStrategy` and `fileOwnershipStrategy` are pure. A `check` line
  carrying `WARNING_PREFIX` is advisory; `refusalsIn` keeps the refusals. `refusalOf(alloc)`
  says why a `release` returned false.
- `worktreeTenancy(holder, roster, force)`, `adopterBlocker` and `parkTenancyBlocker` are the
  CC-141 rule for retire, bulk retire and park: any other identity that is not retired and
  works at or under the tree blocks. `--force` turns the retire refusal into a warning.
- `allocatedWorktree(rows, agentId)`, `parkBlocker`, `parkable` and `liveBlocker` are the
  park rules over journal rows.
- `canonicalPath` and `isAtOrUnder` compare paths through symlinks; `isReviewerSpawn` and
  `isReviewerTreeName` classify reviewers by name.
- `createWorktreeStrategy({ budget, reviewerBudget, treeHolders })` is the worktree strategy
  over `@titan-design/worktree`. Budgets are readers, called on every spawn; implementer and
  reviewer trees draw on separate pools (`DEFAULT_REVIEWER_WORKTREE_BUDGET` is 8), and a
  refusal says who holds them. `reattachWorktree` and `recreateWorktree` bring a removed tree back.
- `unsavedWork(tree, action)` and `dispatchIgnoredFiles` are the one ignored-file policy for
  release and park. `inspectForRelease` applies it over the package's commit checks, and it
  lets go of everything the package does, plus a few more build outputs, an index-only
  `.codewatch/graph.db` and paths a committed `.agent-chat/generated` lists. Any failed read refuses.
- `workBlocker(target, git?)` reports uncommitted or unpushed work in a tree, or in its
  branch when the tree is gone. `heldBranches` lists every branch whose open PR holds an
  agent, and `reviewedAgentName` maps a reviewer's name to the agent it reviews.
- `retireFinished(port, scope)` is the bulk `agent retire --finished`: it plans every agent
  in scope (`spawner`, `prefix` or `stale`; `SCOPE_REQUIRED` refuses an empty scope), then
  retires the planned ones one at a time through `port.retire`. Every skip rule errs towards
  keeping. `FinishedRetirePort` supplies the roster, journal, liveness and retire; its
  `FinishedHolds` supplies the Shepherd and open-PR reads. Each read spawns a process, so
  the host caches them for a whole plan; the package does not.
- `retireAtReport(port, agentId)` parks and retires an opted-in spawner's agent after a
  final `Status:` or `Verdict:` report (`isFinishedReport`). `ReportRetirePort` supplies the
  opt-in, the last report, the Shepherd hold, `park` and `retire`.
- `parkImplementerAtExit` parks a non-reviewer's clean, pushed tree when it exits
  (`ImplementerParkPort` adds the `autoPark.onExit` switch and the burndown `treeHold`).
  `parkReviewerAtReport` parks a reviewer's tree after a final Verdict found in its last
  report or final text (`ReviewerParkPort`). Neither retires the agent.
- `retireMerged(port)` retires exited workers whose reported PR has merged, parking with the
  PR head as backing. `MergedRetirePort` adds `readPr`, the holds, `park` and `retire`.
  `passPrReads` caches answers so one PR costs one read per pass, at most
  `PR_READS_PER_PASS`; `startMergedRetireSweep` runs a pass on an unref'd interval.
- `prStateReader(deps)` reads a PR's state through `gh`. `PrStateDeps` is the host's budget:
  `refusal` can turn a read away before it starts, `gh` runs it, and `after` logs every
  call and starts a cooldown on a rate limit. `prTarget` and `reportPr` parse PR references.
- `treeFingerprint` and `treeChange` detect a reviewer that wrote to the tree it reviewed;
  `reviewerDirtyText` words the notice to its spawner.

## Isolation (`./isolation`)

The isolation strategies a spawn picks from its profile, and the rules that keep a retire
or a park from removing a tree another agent works in.

- `createIsolationRegistry({ worktree })` gives `getStrategy(name)` and `resolve(names)`.
  The host builds the worktree strategy, since it reads host budgets; `resolve` layers
  several names through `composite`, which narrows tools, keeps the last moved cwd and
  force-releases earlier members when a later allocation throws.
- `noneStrategy`, `toolsetStrategy` and `fileOwnershipStrategy` are pure. A `check` line
  carrying `WARNING_PREFIX` is advisory; `refusalsIn` keeps the refusals. `refusalOf(alloc)`
  says why a `release` returned false.
- `worktreeTenancy(holder, roster, force)`, `adopterBlocker` and `parkTenancyBlocker` are the
  CC-141 rule for retire, bulk retire and park: any other identity that is not retired and
  works at or under the tree blocks. `--force` turns the retire refusal into a warning.
- `allocatedWorktree(rows, agentId)`, `parkBlocker`, `parkable` and `liveBlocker` are the
  park rules over journal rows.
- `canonicalPath` and `isAtOrUnder` compare paths through symlinks; `isReviewerSpawn` and
  `isReviewerTreeName` classify reviewers by name.
- `createWorktreeStrategy({ budget, reviewerBudget, treeHolders })` is the worktree strategy
  over `@titan-design/worktree`. Budgets are readers, called on every spawn; implementer and
  reviewer trees draw on separate pools (`DEFAULT_REVIEWER_WORKTREE_BUDGET` is 8), and a
  refusal says who holds them. `reattachWorktree` and `recreateWorktree` bring a removed tree back.
- `unsavedWork(tree, action)` and `dispatchIgnoredFiles` are the one ignored-file policy for
  release and park. `inspectForRelease` applies it over the package's commit checks, and it
  lets go of everything the package does, plus a few more build outputs, an index-only
  `.codewatch/graph.db` and paths a committed `.agent-chat/generated` lists. Any failed read refuses.
- `parkWorktree(target, recheck, listCwds?, mergedPr?)` removes a tree and keeps its branch.
  `lsofCwds` finds a process still in the tree; `readMergedPrs` backs a squash merge whose head
  branch origin deleted. It runs `gh` under `minimalEnv`, so a host whose `gh` needs a token or
  a shim builds its own with `mergedPrReader(gh)`.
- `sweepWorktrees(roster, { store })` classifies every held tree, and `reclaim(entry, { store, strategy })`
  re-checks the work before removing one. `HeldAllocationStore` is the host's record of allocations.
- `rowState`, `repoHeadroom` and `repoSummary` turn a sweep into the state words a seat counts.

## Routing (`./routing`, `./routing/node`)

The workflow table (`shape-v1`) that maps a task's facts to a prior and an implementer
profile, shipped as `workflow/shape-v1.yml`.

- `parseWorkflowTable(text)` gives the table or one problem line per lint failure; every
  value is a closed enum.
- `classifyTask(table, facts)` gives the first matching prior and its reason;
  `profileFor(table, prior, estimate)` gives the profile its class row dispatches.
- A rule with `needsOwns: true` cannot match a task with no owns, so missing facts never
  route down. The shipped table sets it on `small` and `standard`.
- `priorRoute(router, facts, today, label)` keeps or changes a profile in `shadow` or `on`
  mode; `planFacts(planText, slice?)` reads owns and points from a `burndown-slices` block.
- `routeSpawn(input)` is the spawn-time decision. It applies to `auto` and the implementer
  family (`implementer`, `implementer-lite`, `bd-implementer`, `bd-implementer-lite`). The
  table picks the tier; the caller's family keeps its prefix. It never refuses a spawn: a
  missing table, an override, a keep-role (default `fix-round`) or a pick outside the two
  tiers keeps the requested profile and says why in `source`.
- `routeMeta(decision)` writes the decision as the `ROUTE_META_KEYS` fields of a spawn row.
  `summarizeRoutes(rows)` reads such rows back into agreement, would-lite, lite-without-owns,
  fact coverage and candidate counts.
- `./routing/node` has `DEFAULT_WORKFLOW_TABLE`, `readWorkflowTable(root)` and
  `readPriorRouter(mode, root)`.
- `readRouteTable(file)` from `./routing/node` gives the table with its
  `shape-v1@<sha8>` id. It re-reads the file only when the file's mtime or size changes, so a
  spawn path can call it on every spawn.
- `readSpawnFacts(root, taskId, slice?, reqOwns?)` from `./routing/node` reads a spawn's
  facts from an active-work root. Estimate, done_when and tags come from
  `<initiative>/tasks/<taskId>.yml`; a top-level `kind:` becomes a `kind:<x>` tag. Owns come
  from `<initiative>/sources/<taskId>-plan.md`: the named slice's owns and points, else the
  union of owns, else `reqOwns`. The returned `note` says which facts were present and where
  the owns came from. An id found in two initiatives reads the first by name and is marked
  `ambiguous`.
