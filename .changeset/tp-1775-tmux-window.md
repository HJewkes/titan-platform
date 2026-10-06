---
"@titan-design/agent-surface": minor
---

Add a `tmux-window` surface for a host with no iTerm2. It opens a detached window named for the plan in the tmux session `fac` (option `tmuxSession`, socket via `tmuxSocket`) running the fixed launcher line, starts the session when it is missing, and closes with `kill-window` followed by a re-read of the server's windows before reporting `closed: true`. `tmuxWindowPresent` lets a host see an agent's window exit. `surfaceFor` now routes every surface name explicitly and refuses an unknown one with `SurfaceRefused`, so no name falls through to AppleScript.
