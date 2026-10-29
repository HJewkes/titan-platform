---
"@titan-design/github": patch
---

The Octokit client fails a hung REST call after `CORE_TIMEOUT_MS` (60 s), like `restCaller`, and does not retry it (TP-2936).
