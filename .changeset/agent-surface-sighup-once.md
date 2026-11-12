---
"@titan-design/agent-surface": patch
---

An iTerm launch no longer forwards SIGHUP to the child, because the `zsh -lic` in front of the launcher already passes the hangup to the child's process group. tmux and headless launches still forward it: there the launcher is the session leader or has no terminal, and nothing else signals the child.
