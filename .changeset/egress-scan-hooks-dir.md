---
"@titan-design/egress-scan": minor
---

Add the `@titan-design/egress-scan/hooks` subpath: `writeGitHooks` writes a spawn-time git hooks dir that `gitHooksEnv` points git at. Its pre-push runs `titan-egress-scan pre-push` on a baked PATH, refuses when the private term list is missing, and chains to the repo's own hook. A `noRewriteHooksDir` dir also refuses the deletes, main or master updates, refs outside heads and tags and non-fast-forwards git hands the hook, and pushes to a configured mirror remote; a typed `push --mirror` must be refused before git runs. Relative PATH entries are never baked into the hook. Ported from agent-chat's leak guard; the generated hooks are byte-identical to its own.
