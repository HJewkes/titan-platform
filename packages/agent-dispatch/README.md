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
- `dispatchToAgentChat` also takes `configDir`, passed as `--config-dir <path>` to run the
  agent on another Claude account.
- `resumeAgent(bin, name, message, timeoutMs)` runs `agent-chat agent resume <name>
  --message <message>`, so the broker tracks the resumed session. It refuses a name outside
  agent-chat's name shape before running anything. The message is in argv.
- `parkAgent(bin, name, timeoutMs?)` runs `agent-chat agent park <name>`: the broker removes
  an exited agent's clean, pushed worktree and keeps its branch, and `resumeAgent`
  re-creates it. A refusal (live, dirty, unpushed or shared tree) throws `DispatchError`
  with the broker's reason; a broker that cannot be reached throws `BrokerUnavailableError`.
- `messageAgent(bin, name, text, timeoutMs)` runs `agent-chat debug send -- <name> <text>`:
  the broker delivers the text to a live agent as one channel message from the human seat,
  which starts a turn in an idle session. A name with no live session throws
  `DispatchError` with the broker's reason. The text is in argv.
- `dataFence(label, text)` wraps untrusted text in a fence one backtick longer than the
  longest backtick run in it (at least three), preceded by a line saying it is data.
- Every agent-chat call runs with `AGENT_CHAT_NO_AUTOSTART=1`. When the CLI reports that it
  cannot reach the broker, the call throws `BrokerUnavailableError` (a `DispatchError`);
  every other refusal stays a plain `DispatchError`.
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
