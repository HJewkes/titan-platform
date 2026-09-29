# @titan-design/agent-dispatch

A client for agent-chat's supported programmatic surface, the `agent-chat` CLI. It starts
an agent under a named profile with the brief on stdin (never in argv, which `ps` shows to
every local process), builds the argv that resumes an ended agent's Claude Code session
with one more message, and runs binaries by absolute path with a minimal environment.

Tier 1 of the titan-platform DAG, with no dependencies. Ported unchanged from relay's
`daemon/src/dispatch.ts`, `exec.ts` and `session.ts` (`resumeArgs`) by TP-460.

```ts
import { dispatchToAgentChat, resumeArgs, execSafe, minimalEnv } from "@titan-design/agent-dispatch";

dispatchToAgentChat(
  { agentChatBinPath: "/opt/homebrew/bin/agent-chat", peerName: "item-42", profile: "headless-implementer", brief, cwd },
  15_000,
  ["headless-implementer", "headless-reviewer"],
);
```

- `dispatchToAgentChat(req, timeoutMs, allowedProfiles)` refuses a profile outside the
  caller's allowlist and a peer name outside agent-chat's name shape, then runs
  `agent-chat agent spawn <name> <profile> [--briefing <slug>] --brief-stdin`. A zero exit
  means the broker accepted the spawn, not that the work is done. A non-zero exit throws
  `DispatchError` carrying the CLI's stdout reason, else its stderr.
- `resumeArgs(sessionId, message)` returns `claude` argv; run it with `execSafe`. The
  message is in argv here, so callers decide what may go in it.
- `listAgents(bin, timeoutMs)` reads `agent-chat agent ls --json` and returns typed
  `AgentRow`s, skipping a row that lacks a field it relies on. `retire(bin, name,
  timeoutMs, { force })` frees a name and returns the broker's caveats. Both throw
  `DispatchError`, or `DispatchTimeoutError` when the CLI hangs, since a hung retire may
  still have happened.
- `execSafe`, `minimalEnv` and `resolveBinaryPath` never use `PATH` lookup or
  `process.env`, and never a shell.

Profile names, peer-name derivation and profile installation are the caller's policy and
are not in this package.
