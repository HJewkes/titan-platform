---
"@titan-design/agent-surface": minor
---

Add iTerm placement options: `split: 'right' | 'below'` picks the side of the anchor a pane's stack starts on, `maxInTab` opens a tab in the anchor's window once the tab is full, and `tabWindow` opens a tab in a window named by id with no anchor session. An anchored launch reports `inTab`, the session count of the anchor's tab, on its `LaunchHandle`. `iterm-window` and callers that pass none of these behave as before.
