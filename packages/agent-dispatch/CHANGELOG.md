# @titan-design/agent-dispatch

## 0.10.0

### Minor Changes

- 59db533: Add `bootPacket`, which builds an implementer's first-turn packet (git state labelled with its capture time, task card, plan slice excerpt, touch-point excerpts, readiness) within a token budget from injected readers, and `nodeBootReaders`, the readers over a local checkout.
- c1af4ba: Declare the empty subpaths `/profiles`, `/profiles/node`, `/launch`, `/brief`, `/host`, `/roster` and `/gates` so the fold lanes can fill them without sharing `package.json` or `tsup.config.ts`. The root exports are unchanged.
- 73c018b: Add `lastFencedJson(text)`, which parses the last ` ```json ` block of an agent's final message, and optional `role` and `task` on a spawn, sent as agent-chat's `--role` and `--task` so the roster row records the agent's role and task. A task id outside `TASK_ID_PATTERN` is refused before the spawn.
- 74ad076: Add `limitsReport` and `limitsReportSchema` to `./limits`: a pure projection of a planner's dry-run result, the claim ledger and a Shepherd read onto the v1 `/limits` report (binding, roles live against the ledger, pools, refusals with top PR blockers, supply with bookkeeping under `seeded`, worktrees, Shepherd reviews in flight, contradictions). The input is the structural `LimitsPlanInput`; the report reads no config.
- 81395d7: `messageAgent` takes an optional trailing `{ source }` (`WakeSource`: `"watchdog"`, `"shepherd"` or `"console"`), sent as `agent-chat debug send --source <source>` ahead of `--`, so the message arrives labelled `wake_source=<source>` instead of as the owner's words. Without it the argv is unchanged.
- 9411e94: `retire` takes a `caller` option (TP-3622). It is checked against `PEER_NAME_PATTERN` and sent to the agent-chat CLI as `AGENT_CHAT_NAME`, the only addition to the minimal env, so the broker's `agent_retired` event names that caller instead of `human`. `RetireOptions` is exported.
- dcbf00e: Add `routeSpawn` to `./routing`: the spawn-time implementer route over the workflow table, with the implementer family and tier map, `auto`, override, keep-role, shadow and on modes, and a candidate table recorded beside the live one. Add `ROUTE_META_KEYS` and `routeMeta` for the `route_*` fields of a spawn row, and `summarizeRoutes` to read them back into agreement and fact coverage.
- e391005: Add `readSpawnFacts` and `readRouteTable` to `./routing/node`. `readSpawnFacts` reads a spawn's routing facts from an active-work root: estimate, done_when and tags (with a `kind:` field folded in) from the task file, and owns and points from the plan's `burndown-slices` block, falling back to the spawn's own owns. It marks a task id found in two initiatives as ambiguous. `readRouteTable` gives the table with its `shape-v1@<sha8>` id and re-reads the file only when its mtime or size changes.
- d0d51f1: Add the `./routing` and `./routing/node` subpaths: the `shape-v1` workflow table (schema, lint and the shipped default in `workflow/shape-v1.yml`), `classifyTask`, `profileFor` and `priorRoute`, ported from agent-chat's burndown router. A new `needsOwns` rule field keeps a task whose owns are unknown from routing down; the shipped table sets it on `small` and `standard`.
- f85e2ba: Add `spawnAsCaller`, an agent-chat spawn that forwards the caller's `AGENT_CHAT_NAME`, `AGENT_CHAT_AGENT_ID` and `CLAUDE_CONFIG_DIR` and returns the CLI's stdout lines. `buildSpawnArgs` takes `host`, `account`, `surface` and `remoteControl`; its argv is unchanged when they are absent.
- b7c8320: `DispatchRequest` takes an optional `worktree`, passed to `agent-chat agent spawn` as `--worktree` so the agent adopts that path. Autoresearch implementers now adopt the engine's idea tree, which sits at the ratchet head, instead of working in a fresh worktree cut from the clone's default branch, and an exploit lane no longer moves a tree the agent already sits in.
- 292fbe9: `@titan-design/agent-dispatch/profiles` now holds agent-chat's profile schema and parser: `parseProfile`, the closed value lists with their type guards, and `harnessRefusal`. The parser is split by field family, and its checks, messages, `denies` alias and derived denies match agent-chat's. Unknown keys warn. A `codex` profile that names a Claude model is refused at load, and any `codex` profile is refused at launch with `harness_unsupported`.
- ed8310b: `@titan-design/agent-dispatch/brief` now carries the return contract (the implementer and reviewer blocks, with and without the Shepherd handoff), `withReturnContract` and `contractOf`, the standing rules, and `lintBrief` with `repoVisibilityReader`, ported from agent-chat. The block text is byte-identical to agent-chat's, pinned by a golden fixture. Profiles are structural (`ContractProfile`), and `repoVisibilityReader` takes its git and gh runners from the caller.
- fa9516b: Add the `/host` ports `AgentJournal`, `PresencePort`, `AdmissionLedger` (types only) and `RetireHoldPort`, plus an in-memory `memoryHost` that implements all four. Its admission ledger always admits and records each call.
- 26598f3: The `/roster` subpath now carries the agent-chat roster fold: `foldAgent` projects an agent's journal rows into its identity through a per-event-kind reducer table (the branching that made the original cognitive complexity 39 is gone), with `AgentLog`, `pairPresence`, `filterRoster`/`viewRoster`/`newestByName`, and the predecessor briefing section (`resolvePredecessor`) over the `/host` journal port. The predecessor briefing reads the message lookup and transcript check through a `PredecessorSource` the product supplies.
- 792265b: `/roster` gains the agent records: exit-report (what an unreported exit was doing, as a bounded pattern), the pure half of resume-session (resume refusals, retired-name pointer, reply text), the mode-switch plan, spawn-provenance (route meta keyed by `/routing`'s `ROUTE_META_KEYS`) and brief-paths (symlink-crossing brief warnings).
- db5ea61: Add `sqliteHost` to `@titan-design/agent-dispatch/host`: the same ports as `memoryHost`, with the journal kept in SQLite through `@titan-design/store-sqlite` so a reopened database folds the same rows in append order.
- a20c348: New `receivesMessages(row)`: whether `messageAgent` can reach the agent a roster row names. Its unregistered `debug send` reaches only a connected session, so only a `live` row counts; a `detached` row is as unreachable as an `exited` one.
- 8e09d50: Add the `./isolation` subpath: the isolation strategy types and registry factory, the `none`, `toolset-limited` and `file-ownership` strategies, the shared CC-141 tenancy rule for retire and park, the park rules, and the reviewer name rules (TP-646 I1a).
- fcb7e85: Add `stablePrefix(sections)`: joins ordered named sections deterministically into `{text, hash}` and refuses agent names, worktree paths, ISO dates, 40-hex shas and `<spawner>` fill-ins.
- 3d709d8: Offer a forced retire on the agent page once agent-chat's grace has passed (TP-4600). `listAgents` passes through each row's `exitedAt`. The factory's retire-agent route sends `--force` only when the roster's exit time is at least two minutes old, and its preview reports `forceStop`. The console's Retire sheet reads back the exit time and offers "Retire and discard" only when `forceStop` is null, with the same CHANGED re-check at act time.
- 9396ce4: Add the worktree isolation strategy to `./isolation`: `createWorktreeStrategy` with per-spawn budget readers, the implementer and reviewer pools, and `inspectForRelease`, judged by one ignored-file policy (`unsavedWork`, `dispatchIgnoredFiles`) that keeps paid codewatch data and honours a committed `.agent-chat/generated` (TP-646 I1b).
- 29062e0: Add park, sweep and worktree headroom to `./isolation`: `parkWorktree` with the process check and a merged-PR reader (`readMergedPrs`, `mergedPrReader`), `sweepWorktrees` and `reclaim` over a `HeldAllocationStore`, and the worktree state words (`rowState`, `repoHeadroom`, `repoSummary`) (TP-646 I1c).
- 9d74995: Add the retire and park-at-exit rules to `./isolation`: the bulk finished retire over a `FinishedHolds` port, the retire at the final report, the merged-PR retire with its PR-state reader, the park of a finished tree at exit, the branches an open PR holds, and the reviewer-tree guard (TP-646 I1d).

### Patch Changes

- 2380fd4: Walk retired generations in Shepherd's reviewer independence proof (TP-4132). agent-dispatch adds `listAgentLineage`, which reads `agent ls --json --include-retired`, parses each row's `retired` marker, and on an agent-chat that predates the flag falls back to the plain roster marked incomplete. Factory proves independence against that lineage, so the spawner of a seat's retired first generation counts as an ancestor; an incomplete lineage proves nothing. Retired rows feed the proof only: the roster that names, resumes and finds reviewers never includes them.
- 9b42150: Use the shared `isRecord`, `isObjectLike` and `errorCode` from `@titan-design/rpc-protocol/narrow` in place of local copies. Behaviour is unchanged.
- 5f33d7a: Replace the type assertions in the limits resolver, the limits file readers, the agent row check and the sync exec failure path with runtime narrowing, and parse the resolved limit values with zod. No change for valid input.
- cb470f4: Carry `predecessor` from `agent-chat agent ls --json` through to Shepherd's roster. `AgentRow` gains an optional
  `predecessor`: a string or null passes through, a missing or mistyped key stays absent and is never read as null. The
  reviewer roster maps it the same way, so lineage can prove a reviewer independent once agent-chat reports the field,
  and a roster without it still proves nothing.
- 4eb9812: An agent-chat call that finds no broker listening now throws `BrokerUnavailableError` instead of a plain `DispatchError`. Exit 69 (agent-chat's EX_UNAVAILABLE) always means an unreachable broker, and agent-chat's no-autostart probe line ("broker unavailable: no broker is listening and AGENT_CHAT_NO_AUTOSTART=1 forbids starting one") joins the whole-line broker-down list, because `agent ls` and the other legacy verbs exit 1 on it.

  Shepherd's review steps wait out an unreachable broker with a doubling wait (from the poll interval up to 2 min) for at most the review wiring's `brokerDownWaitMs` (default 15 min). Only then is the run held as no-reviewer, with the reason "broker unavailable (no broker answered for 15 min)". Before this change, a broker that came up after serve booted got the run held on the first refused roster read.

- 9028bd0: The bulk finished-agent retire now treats a blank (empty or whitespace-only) caller or spawner name as absent, so it can no longer match an agent by a blank name.
- Updated dependencies [ca8e8b7]
- Updated dependencies [c58d555]
- Updated dependencies [8b92ba0]
- Updated dependencies [f3d3107]
- Updated dependencies [5edd38d]
- Updated dependencies [c1f9297]
- Updated dependencies [8031169]
- Updated dependencies [247171d]
- Updated dependencies [9ad447f]
- Updated dependencies [d5e44a5]
  - @titan-design/worktree@0.4.0
  - @titan-design/store-sqlite@0.5.0
  - @titan-design/rpc-protocol@0.4.0

## 0.9.0

### Minor Changes

- d82852a: TP-3637: a decided answer never waives a fix-proof. `ServiceAnswer` now carries the broker's `provenance` marker when agent-chat sets one. gateNotify refuses a `decided` answer on every gate, because it would resolve as owner-remote and the decider is not the owner. It also refuses a `waive-proof` answer unless it is `human-endorsed`, so an unmarked relay fails closed. A refused answer leaves the gate pending, settles the ask as `refused`, and writes no waiver row. The owner's own terminal answer still waives.

## 0.8.0

### Minor Changes

- 3189a46: Add `observeAgentChatCalls`, which reports `{ verb, ms, outcome }` for every agent-chat call, spawn included. The verb carries no peer name or briefing.
- 06506bc: `execSafeAsync`, `runAgentChatAsync`, `askHuman`, `readAnswers` and `dismissAsk` take an optional `AbortSignal`. Aborting it kills the child and rejects with the new `ExecAbortedError`. A signal that has already aborted starts no child.
- 8f81511: `parkAgent` is now async and returns `Promise<ParkResult>`: it runs `agent-chat agent park` through `runAgentChatAsync`, so the caller's event loop stays free while the broker works. Callers must `await` it; a refusal or an unreachable broker now rejects rather than throws.
- 7330b11: `retire`, `messageAgent`, `resumeAgent` and `dispatchToAgentChat` are async and return Promises, so a long-lived caller's event loop stays free while the agent-chat child answers; refusals now reject instead of throw. `execSafeAsync` takes an optional trailing `cwd`. The unexported `runAgentChat` is gone.
- ca0dd12: `buildSpawnArgs`, `dispatchToAgentChat`, `buildResumeAgentArgs` and `resumeAgent` take an opt-in `launchedBy: "shepherd"` and optional `launchReason`, sent as `--launched-by shepherd [--launch-reason <text>]` (TP-3514, CC-1466). It is a roster record, never the `--spawned-as` gate input. A caller that does not opt in sends exactly the argv it sent before. Shepherd's spawns and resumes opt in; they need an agent-chat CLI that knows `--launched-by`.
- ca0dd12: `parkAgent(bin, name, timeoutMs, options?)` now requires its timeout, so no park call waits on the broker unbounded; pass `DEFAULT_PARK_TIMEOUT_MS` for the old default. `buildParkArgs` and `parkAgent` take an opt-in `{ noFixRoundCheck: true }`, sent as `--no-fix-round-check` (TP-3515, CC-1470); a caller that leaves it out sends the same argv as before. Shepherd's park step opts in, since agent-chat would otherwise call back into Shepherd to ask about a fix round; it needs an agent-chat CLI that knows the flag.

### Patch Changes

- 556b5e2: The installed-profile guard follows `AGENT_CHAT_HOME` (else `$HOME/.agent-chat/profiles`), refuses a profile name outside `^[a-z0-9][a-z0-9._-]*$` before building a path, and `agentChatEnv()` forwards a non-empty `AGENT_CHAT_HOME` so the CLI reaches the broker whose profiles were checked.
- 0acca69: A CLI exit whose stderr is the line `broker did not answer <frame>_result` now rejects with `DispatchTimeoutError` instead of a plain `DispatchError`, since the frame may have landed.
- ff27157: README: record that relay's daemon consumes the package and has deleted its copy (TP-460 c).

## 0.7.0

### Minor Changes

- 3199c5a: Add `askHuman`, `readAnswers` and `dismissAsk` over agent-chat's `ask`, `answers` and `dismiss` verbs, so a process that is not a Claude session can put a question on the human queue and read the answer back later (CC-169). `execSafeAsync` takes an optional `input` for the child's stdin.

## 0.6.0

### Minor Changes

- 2b1640a: Add `assertInstalledHeadless` and `installedProfilesDir` (ported from relay's profile guard): `dispatchToAgentChat` now refuses a profile whose installed file is not `"surface": "headless"`, and takes `profilesDir`. A spawn that times out throws `DispatchTimeoutError`. `listAgents` validates every required `AgentRow` field (now including `surface` and `generation`); the nullable fields are optional and dropped when mistyped.

## 0.5.0

### Minor Changes

- 378021d: Add the `./limits` subpath: `limitsSchema`, `LIMIT_DEFAULTS`, `parseLimits`, `resolveLimits`, `checkLimits`, `liftQuestion` and `grantFromAnswer`, a versioned per-pool, per-profile and per-seat limits block with time-boxed overrides that expire by themselves. `./limits/node` adds `loadLimits(path)` and `readGrants(path)`. zod becomes a peer dependency for these subpaths.

## 0.4.0

### Minor Changes

- 0ae0123: `listAgents` now returns a promise and reads the roster through the new `execSafeAsync`, so a slow `agent ls --json` no longer blocks the caller's event loop; the Shepherd roster reader awaits it.

### Patch Changes

- fe4badd: `DispatchError`, `BrokerUnavailableError` and `DispatchTimeoutError` carry a fixed `name`, so a caller can record which kind of failure it was without its message.

## 0.3.0

### Minor Changes

- 86bb7a2: `messageAgent(bin, name, text, timeoutMs)` delivers one chat message to a live agent through `agent-chat debug send`, which starts a turn in an idle session.

## 0.2.0

### Minor Changes

- dc7be96: New `parkAgent(bin, name, timeoutMs?)` runs `agent-chat agent park <name>`, which removes an exited agent's clean, pushed worktree and keeps its branch. A broker refusal throws `DispatchError` with the broker's reason, and a broker that cannot be reached throws `BrokerUnavailableError`. Also exports `buildParkArgs`, `DEFAULT_PARK_TIMEOUT_MS` and `ParkResult`.

## 0.1.0

### Minor Changes

- 255e37e: Add `@titan-design/agent-dispatch`, ported unchanged from relay's daemon: `dispatchToAgentChat` and `buildSpawnArgs` (brief on stdin under `--brief-stdin`), `resumeArgs`, and `execSafe`, `minimalEnv` and `resolveBinaryPath`. The one API change from relay: the profile allowlist is the caller's third argument instead of relay's two profile constants.
- cdc5793: Add `listAgents` (reads `agent-chat agent ls --json` into typed `AgentRow`s) and `retire` (with `force`), plus `DispatchTimeoutError` for a CLI that hangs.
- ffe1778: Add `resumeAgent` over `agent-chat agent resume <name> --message`, `DispatchRequest.configDir` (passed as `--config-dir`), `dataFence` for untrusted text, and `BrokerUnavailableError` for an unreachable broker. Every agent-chat call now sets `AGENT_CHAT_NO_AUTOSTART=1`.
