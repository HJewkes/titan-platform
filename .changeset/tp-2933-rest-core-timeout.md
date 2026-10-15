---
"@titan-design/github": patch
---

`restCaller` passes `CORE_TIMEOUT_MS` (60 s) to `gh` for every core REST call, so a hung `gh` is killed and the call rejects instead of never settling (TP-2933 a).
