# @titan-design/agent-dispatch

## 0.1.0

### Minor Changes

- 255e37e: Add `@titan-design/agent-dispatch`, ported unchanged from relay's daemon: `dispatchToAgentChat` and `buildSpawnArgs` (brief on stdin under `--brief-stdin`), `resumeArgs`, and `execSafe`, `minimalEnv` and `resolveBinaryPath`. The one API change from relay: the profile allowlist is the caller's third argument instead of relay's two profile constants.
- cdc5793: Add `listAgents` (reads `agent-chat agent ls --json` into typed `AgentRow`s) and `retire` (with `force`), plus `DispatchTimeoutError` for a CLI that hangs.
- ffe1778: Add `resumeAgent` over `agent-chat agent resume <name> --message`, `DispatchRequest.configDir` (passed as `--config-dir`), `dataFence` for untrusted text, and `BrokerUnavailableError` for an unreachable broker. Every agent-chat call now sets `AGENT_CHAT_NO_AUTOSTART=1`.
