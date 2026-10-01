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
import { BrokerUnavailableError, dataFence, dispatchToAgentChat, execSafe, listAgents, messageAgent, minimalEnv, parkAgent, resolveBinaryPath, resumeAgent, resumeArgs, retire } from "@titan-design/agent-dispatch";

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

const ended = listAgents("/opt/homebrew/bin/agent-chat", 15_000).filter((a) => a.presence === "exited");
retire("/opt/homebrew/bin/agent-chat", "item-42", 15_000); // { name: "item-42", caveats: [] }
parkAgent("/opt/homebrew/bin/agent-chat", "item-7"); // { name: "item-7", lines: ["Parked item-7.", ...] }
messageAgent("/opt/homebrew/bin/agent-chat", "item-9", "CI is red; the log tail follows", 15_000); // a live agent's next turn

try {
  resumeAgent("/opt/homebrew/bin/agent-chat", "item-42", dataFence("CI log", logTail), 15_000);
  // { name: "item-42", lines: ["Resumed item-42 on its existing conversation, ...", ...] }
} catch (err) {
  if (!(err instanceof BrokerUnavailableError)) throw err;
  // nothing reached the broker; retry later
}

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
- `listAgents` needs an agent-chat with `agent ls --json`; an older one fails with its
  usage error. A row missing a required field is skipped, not guessed at.
- `retire` throws `DispatchTimeoutError` (a `DispatchError`) when the CLI hangs: the broker
  may already have retired the agent, so read the roster before retrying.
- `parkAgent` throws `DispatchError` when the broker refuses a live, dirty, unpushed or
  shared tree. A broker that predates the verb (CC-282) times out on the CLI side and comes
  back as a refusal naming a broker restart.
- `BrokerUnavailableError` is raised only for agent-chat's own unreachable-broker lines on
  stderr ("could not reach or start the agent-chat broker", a restart's "was NOT sent", or a
  bare `connect ECONNREFUSED|ENOENT <socket>`). A refusal that quotes that text elsewhere
  stays a plain `DispatchError`.
- Calls set `AGENT_CHAT_NO_AUTOSTART=1`. An agent-chat that does not honour it yet still
  starts a broker when none is running.
- `resumeAgent` puts the message in argv, where `ps` shows it. Fence untrusted text with
  `dataFence` and keep secrets out of it.
- `messageAgent` reaches a live agent only, and the broker delivers the text from the human
  seat. For an ended agent use `resumeAgent`. The text is in argv.
- `resumeArgs` puts the message in argv. Resuming a live agent starts a second process on
  the same transcript; check liveness first.

## Where it came from

Ported unchanged from relay's `daemon/src/dispatch.ts`, `exec.ts` and the `resumeArgs`
builder in `session.ts` (TP-460), with their tests. relay consumes the release and deletes
its copy in a follow-up. `listAgents` and `retire` were added afterwards for Shepherd, then `resumeAgent`,
`configDir`, `BrokerUnavailableError` and `dataFence` (ported from agent-chat's burndown
brief) by TP-518, `parkAgent` by TP-548, and `messageAgent` by TP-728.
