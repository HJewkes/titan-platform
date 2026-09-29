# agent-dispatch

**Tier 1.** No titan dependencies.

```sh
npm install @titan-design/agent-dispatch
```

## The problem it solves

agent-chat has no library entry point that spawns an agent, and its broker serves no spawn
route over HTTP. The supported programmatic surface is the `agent-chat` CLI. Shelling out
to it safely has three traps: `PATH` is not what a launchd job expects, `process.env` leaks
into the child, and a brief passed in argv is readable by every local process through `ps`.

This package is the one client that handles all three. `dispatchToAgentChat` sends the
brief on stdin under `--brief-stdin`, so no brief text ever reaches argv. `execSafe` runs
an absolute path with a minimal environment and no shell.

## When to reach for it

A product that must start an agent-chat agent under a named profile, or give an ended
agent's Claude Code session one more message, from code. To run one headless Claude turn
in-process with a typed result, use [agent](./agent.md) instead. To record which process
owns a running execution, use [agent-lifecycle](./agent-lifecycle.md).

## Example

Verified against 0.0.0.

```ts
import { execSafe, dispatchToAgentChat, minimalEnv, resolveBinaryPath, resumeArgs } from "@titan-design/agent-dispatch";

const profiles = ["headless-implementer", "headless-reviewer"];

dispatchToAgentChat(
  {
    agentChatBinPath: "/opt/homebrew/bin/agent-chat",
    peerName: "item-42",
    profile: "headless-implementer",
    brief: "Fix the squeaky floor",
    briefing: "my-initiative",
    cwd: "/path/to/repo",
  },
  15_000,
  profiles,
);
// { peerName: "item-42" } once the broker accepts the spawn

const claude = resolveBinaryPath("/opt/homebrew/bin/claude", "claude");
const turn = execSafe(claude, resumeArgs(sessionId, "CI is red; see the log"), minimalEnv(), 600_000, worktree);
```

## What it deliberately does not do

It holds no profile names, derives no peer names and installs no profile files: those are
product policy, so the allowlist is an argument. It does not wait for the agent's work,
decide whether an agent is live before a resume, or talk to the broker's socket directly.

## Gotchas

- A zero exit from `dispatchToAgentChat` means "started", not "done".
- A failed spawn throws `DispatchError` with the CLI's stdout reason (broker refusals,
  including a name held by a live agent) or else its stderr (usage errors, such as an
  agent-chat too old to know `--brief-stdin`).
- `execSafe` returns a non-zero exit instead of throwing. It throws `ExecTimeoutError` on a
  timeout, because a timed-out child may already have acted, and `ExecError` when the
  binary cannot start.
- `resumeArgs` puts the message in argv. Resuming a live agent starts a second process on
  the same transcript; check liveness first.

## Where it came from

Ported unchanged from relay's `daemon/src/dispatch.ts`, `exec.ts` and the `resumeArgs`
builder in `session.ts` (TP-460), with their tests. relay consumes the release and deletes
its copy in a follow-up.
