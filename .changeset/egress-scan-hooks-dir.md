---
"@titan-design/egress-scan": minor
---

Add the `@titan-design/egress-scan/hooks` subpath: `writeGitHooks` writes a spawn-time git hooks dir that `gitHooksEnv` points git at. Its pre-push runs `titan-egress-scan pre-push` on a baked PATH, refuses when the private term list is missing, and chains to the repo's own hook. A `noRewriteHooksDir` dir also refuses deletes, main or master updates, refs outside heads and tags, mirror remotes and non-fast-forwards. Ported from agent-chat's leak guard; the generated hooks are byte-identical to its own.
