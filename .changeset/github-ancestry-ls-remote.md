---
"@titan-design/github": minor
---

Add `compareAncestry(repo, base, head)` to `GitHubWire` and `GitHubPort`: the compare API's `status` as `ahead`, `behind`, `identical` or `diverged`, and `missing` on a 404. Add `lsRemotePullHead(exec, remoteUrl, n)`, which reads `refs/pull/<n>/head` through `git ls-remote` and answers the sha or null; the credential rides in the child env, a URL carrying one is refused, and a failed read throws `LsRemoteError`. New exports `Ancestry`, `GitExec`, `execGit`, `LsRemoteOptions` and `LsRemoteError`. `fakeGitHub` answers both from its history: `compareAncestry` walks `commits`, and `fake.gitExec` answers each PR's head.
