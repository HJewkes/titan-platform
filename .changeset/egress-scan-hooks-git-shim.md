---
"@titan-design/egress-scan": minor
---

`/hooks` gains the agent `git` shim: `gitShimScript`, `writeGitShim` and `findRealGit` (which never returns a shim, this one or another, as the real git), the exec-path mirror (`writeGitMirror`, `gitMirrorDirFor`, `mirrorEntries`, `probeGit`), and the shim header check (`SHIM_HEADER`, `isAgentChatShim`, `holdsAgentChatShim`). The shim's transport pin narrows `GIT_ALLOW_PROTOCOL` to `@titan-design/worktree`'s safe list and gives git the same environment as its `withPinnedGitProtocols`. egress-scan now depends on `@titan-design/worktree` and moves to tier 1.
