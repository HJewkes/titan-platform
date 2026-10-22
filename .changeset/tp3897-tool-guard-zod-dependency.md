---
"@titan-design/tool-guard": patch
---

List `zod` under `dependencies` instead of `peerDependencies`. The `titan-merge-lint` and
`titan-tool-guard` bins import it at run time, so `npx -p @titan-design/tool-guard` failed with
`ERR_MODULE_NOT_FOUND` wherever npm runs with `legacy-peer-deps=true`.
