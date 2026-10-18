# @titan-design/agent-dispatch

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
