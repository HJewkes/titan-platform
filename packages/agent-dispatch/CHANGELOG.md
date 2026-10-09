# @titan-design/agent-dispatch

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
