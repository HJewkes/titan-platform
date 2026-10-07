# @titan-design/agent-surface

## 0.3.0

### Minor Changes

- 6d2b5e5: Add a `tmux-window` surface for a host with no iTerm2. It opens a detached window named for the plan in the tmux session `fac` (option `tmuxSession`, socket via `tmuxSocket`) running the fixed launcher line, starts the session when it is missing, and closes with `kill-window` followed by a re-read of the server's windows before reporting `closed: true`. `tmuxWindowPresent` lets a host see an agent's window exit. `surfaceFor` now routes every surface name explicitly and refuses an unknown one with `SurfaceRefused`, so no name falls through to AppleScript.

### Patch Changes

- 98943f9: `close()` on a tmux window that already exited now reports `closed: true` instead of failing, and a `tmuxSession` containing `:` or `.` is refused, since tmux would rename it.

## 0.2.1

### Patch Changes

- 3fe6707: Point the docs at `runAgent` with `harness: "claude-print"` instead of `runClaudePrint` for bounded `claude -p` runs.

## 0.2.0

### Minor Changes

- c52b38f: Add iTerm placement options: `split: 'right' | 'below'` picks the side of the anchor a pane's stack starts on, `maxInTab` opens a tab in the anchor's window once the tab is full, and `tabWindow` opens a tab in a window named by id with no anchor session. An anchored launch reports `inTab`, the session count of the anchor's tab, on its `LaunchHandle`. `iterm-window` and callers that pass none of these behave as before.

### Patch Changes

- b631bc7: Time out the iTerm `osascript` calls (10 s) and the launch-check `ps` call (5 s) with `SIGKILL`, so an Automation prompt or a wedged iTerm2 no longer blocks surface open and close forever. A timeout reads as unknown, never present or gone.

## 0.1.0

### Minor Changes

- af604d5: New package: headless and iTerm2 agent surfaces with an injected launcher argv, the launch check, pane title and colour escapes, the stderr tail and login diagnosis, and the `titan-agent-launch` bin that execs a launch plan. Extracted from agent-chat.
