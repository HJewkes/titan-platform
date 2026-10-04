# @titan-design/agent-surface

## 0.2.0

### Minor Changes

- c52b38f: Add iTerm placement options: `split: 'right' | 'below'` picks the side of the anchor a pane's stack starts on, `maxInTab` opens a tab in the anchor's window once the tab is full, and `tabWindow` opens a tab in a window named by id with no anchor session. An anchored launch reports `inTab`, the session count of the anchor's tab, on its `LaunchHandle`. `iterm-window` and callers that pass none of these behave as before.

### Patch Changes

- b631bc7: Time out the iTerm `osascript` calls (10 s) and the launch-check `ps` call (5 s) with `SIGKILL`, so an Automation prompt or a wedged iTerm2 no longer blocks surface open and close forever. A timeout reads as unknown, never present or gone.

## 0.1.0

### Minor Changes

- af604d5: New package: headless and iTerm2 agent surfaces with an injected launcher argv, the launch check, pane title and colour escapes, the stderr tail and login diagnosis, and the `titan-agent-launch` bin that execs a launch plan. Extracted from agent-chat.
