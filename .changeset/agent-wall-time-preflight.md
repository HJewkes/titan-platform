---
"@titan-design/agent": patch
---

Reject `wallTimeMs` above the local timer range (2^31 - 1) in shared preflight, so Codex requests fail with `invalid_request` instead of firing their deadline at once.
