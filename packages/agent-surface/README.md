# @titan-design/agent-surface

Where a spawned agent is presented, and the launcher that starts it there. A surface is
headless (a detached child with discarded streams), an iTerm2 pane, tab or window placed
beside an anchor session by UUID, never by focus, or a window in a tmux session. Every
surface launches one fixed command supplied by the host; that command reads a launch plan
from disk, so a model-authored brief never reaches a command line or an AppleScript string.

Tier 1 of the titan-platform DAG, with no dependencies. Extracted from agent-chat's
`agents/surfaces/`, `run-agent.ts`, `launch-output.ts` and `pane-identity.ts` (TP-639).

## Library

```ts
import { surfaceFor, type Launcher } from "@titan-design/agent-surface";

const launcher: Launcher = {
  argv: id => [process.execPath, "/path/to/titan-agent-launch", `/state/agents/${id}/plan.json`],
  env: { STATE_HOME: "/state" },
  relaunchPath: id => `/state/agents/${id}/relaunch`,
};
const handle = await surfaceFor("iterm-pane", launcher, { anchor: process.env.ITERM_SESSION_ID }).launch(plan);
```

Placement is the host's decision, passed as options. `split: 'right' | 'below'` picks the
side of the anchor a pane's stack starts on. `maxInTab` turns a pane into a tab in the
anchor's window once the tab holds that many sessions. `tabWindow` (an iTerm2 window id)
opens a tab in that window with no anchor. An anchored launch reports `inTab`, the session
count of the anchor's tab, on its handle. `iterm-window` ignores all of them.

`tmux-window` is for a host with no iTerm2, such as a Linux factory server. It runs
`tmux new-window -d -t =fac: -n <title> '<launcher line>'` and records the window id (`@N`)
as `paneRef`; a missing session is started with `new-session`, with a notice. `tmuxSession`
overrides `fac` and `tmuxSocket` adds `-L <name>`. The window closes when the agent exits,
so the host infers that exit with `tmuxWindowPresent`. `close()` runs `kill-window` and then
re-lists the server's windows before it reports `closed: true`. Resume is an ordinary launch
into a new window. The line runs through the tmux server's `default-shell`, which must be a
POSIX shell, and tmux's own `remain-on-exit` must stay off.

`AppleScriptRunner`, `SpawnFn` and `ProcessProbe` are injectable, so the suites run on Linux.

## Command line

```sh
titan-agent-launch [--launcher-pid-env NAME] <plan.json>
```

Writes the pane title (and, in iTerm, the tab colour and badge), then execs `plan.bin` with
`plan.args`, `plan.env` over its own environment, `plan.unsetEnv` deleted, and its own pid in
`NAME` (default `TITAN_AGENT_LAUNCHER_PID`). A headless plan's `stdin` is the brief. The
stderr tail goes to `stderr-tail.txt` beside the plan. It exits the way the agent did; 64 is
a usage error and 66 an unreadable plan.

The bin execs `plan.bin` as written and inherits its environment unscrubbed. A host that
resolves `claude` or scrubs secrets calls `runAgent(plan, { resolveBin, baseEnv })` instead.
