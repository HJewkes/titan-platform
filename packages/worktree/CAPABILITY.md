# worktree: use this when

<!-- One to three sentences for a reader deciding whether to reuse this or build something new. Feeds CAPABILITIES.md. -->

You give each headless agent its own git worktree and branch under a per-repository budget, and must never lose its commits: allocation adopts a crashed agent's branch, release and park refuse a tree with uncommitted or unpushed work, and a sweep finds trees nobody released. Inputs are plain records and the budget is a parameter, so the caller keeps its own roster and journal. Launching the agent process is agent-surface; deciding which isolation strategy applies is agent-dispatch.
