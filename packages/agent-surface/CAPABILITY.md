# agent-surface: use this when

<!-- One to three sentences for a reader deciding whether to reuse this or build something new. Feeds CAPABILITIES.md. -->

A host must present a long-lived agent somewhere: detached and headless, or in an iTerm2 pane, tab or window it can later close and confirm closed. The host injects its launcher argv; `titan-agent-launch <plan.json>` is the launcher that execs a written plan with no shell, stamps its own pid, and keeps a stderr tail. For a bounded `claude -p` run that returns a result, use `runClaudePrint` in agent instead.
