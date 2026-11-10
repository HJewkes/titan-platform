---
"@titan-design/github": patch
---

Split `port.ts`: the port contract types move to `port-types.ts`, `githubPort()` to `github-port.ts`, and `isRetryableWrite` and `httpStatusOf` to `rest.ts`. `port.ts` stays as a barrel, so every export keeps its path. No behaviour change; the `update-branch-retry.ts` and `port.ts` import cycle is gone.
