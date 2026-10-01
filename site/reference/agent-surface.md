# agent-surface

**Tier 1.** No titan dependencies.

```sh
npm install @titan-design/agent-surface
```

## The problem it solves

A host that spawns long-lived agents has to put each one somewhere: a detached process
nobody watches, or a terminal pane a human can type into. Both have failure modes that look
healthy. A headless child with piped, unread streams fills the kernel buffer and blocks
forever while still attached. A pane placed by "current window" lands wherever focus
happens to be. A command typed into a fresh shell picks up the human's keystrokes. A close
script that ran is not a pane that closed.

The primitive is `surfaceFor(name, launcher, options)`. It returns a `Surface` whose
`launch(plan)` starts the host's fixed launcher command and whose `close(handle)` tears down
only what it opened, then looks again before saying so. The launcher, `titan-agent-launch`,
reads the plan from disk and execs it with an argv array, so the brief never passes through
a shell or AppleScript.

## When to reach for it

A host process that dispatches agents which outlive the request: a broker, a factory, a
supervisor. Use `headless` for unattended work and `iterm-pane`, `iterm-tab` or
`iterm-window` when a human should watch or answer. For a bounded `claude -p` run that
returns a result and exits, use `runClaudePrint` in [agent](./agent.md); it is a different
job.

## Example

Verified against 0.0.0 (unreleased).

```ts
import { surfaceFor, type Launcher, type LaunchPlan } from "@titan-design/agent-surface";

const launcher: Launcher = {
  argv: id => [process.execPath, "/opt/tools/titan-agent-launch.js", `/var/state/agents/${id}/plan.json`],
  env: { STATE_HOME: "/var/state" },
  relaunchPath: id => `/var/state/agents/${id}/relaunch`,
};

// The host writes this plan to /var/state/agents/ag01/plan.json first.
const plan: LaunchPlan = {
  agentId: "ag01",
  bin: "/usr/local/bin/claude",
  args: ["-p", "--model", "sonnet"],
  cwd: "/work/repo",
  env: { AGENT_NAME: "scout" },
  stdin: "Audit the parser.",
  title: "scout",
  surface: "headless",
};

const handle = await surfaceFor("headless", launcher).launch(plan);
const { code } = await handle.exited!;
```

## What it deliberately does not do

- It does not build launch plans, choose a Claude account, or scrub secrets. The host does,
  and passes `baseEnv` and `resolveBin` to `runAgent` when it runs the launcher in-process.
- It does not track which agents are live. `columnAfter` is the host's answer to "which
  pane did the last agent in this column get".
- It reads no host config. Seat prefixes and colours arrive through `PaneSources`.

## Gotchas

- `launch` never resolves `exited` for an iTerm surface: the host does not own a pane's
  process. Infer a visible agent's exit from presence instead.
- `launchFailed` resolves only on positive evidence that the launcher is absent from the
  pane's tty. It never resolves otherwise, so race it against your own attach timeout.
- The launch check matches the last two words of `launcher.argv(id)`. Make those unique
  per agent, for example a verb and the id, or a plan path.
- A launcher env value or argv word with a double quote or backslash is refused for a
  pane: iTerm2's command parameter cannot carry it intact.
- The `titan-agent-launch` bin execs `plan.bin` as written and inherits its environment.

## Where it came from

Extracted from agent-chat's `agents/surfaces/`, `run-agent.ts`, `launch-output.ts` and
`pane-identity.ts` (TP-639), with the launcher argv, state paths, launcher pid variable
and pane colour sources turned into parameters. The suites moved with it.
