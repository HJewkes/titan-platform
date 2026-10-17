# worktree: use this when

<!-- One to three sentences for a reader deciding whether to reuse this or build something new. Feeds CAPABILITIES.md. -->

You give each headless agent its own git worktree and branch under a per-repository budget, and must never lose its commits: allocation adopts a crashed agent's branch, release and park refuse a tree with uncommitted or unpushed work, and a sweep finds trees nobody released. Inputs are plain records and the budget is a parameter, so the caller keeps its own roster and journal. Launching the agent process is agent-surface; deciding which isolation strategy applies is agent-dispatch.

An explicit releaseProof opt-in recognizes the exact merged PR tip or its commit membership while retaining git-only defaults and every file-loss/nonforced-removal guard.

Failed releases expose an optional ordinary-changes code, and missing assigned allocation records have a typed error, so products can retain their wording without parsing diagnostics or changing safety.

Use fetchDefaultTip when a caller must refuse an unavailable origin instead of falling back to local HEAD; its existing fetch shares one timeout budget across default-branch candidates.
