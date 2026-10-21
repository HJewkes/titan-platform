---
"@titan-design/anthropic-account": patch
---

List `zod` under `dependencies` instead of `peerDependencies`. The `anthropic-account` bin imports
it at run time, so `npx -p @titan-design/anthropic-account` failed with `ERR_MODULE_NOT_FOUND`
wherever npm runs with `legacy-peer-deps=true`.
