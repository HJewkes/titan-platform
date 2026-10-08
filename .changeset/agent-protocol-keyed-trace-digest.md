---
"@titan-design/agent-protocol": minor
---

Key the trace redaction digest. `RedactTraceOptions` now takes a required `key`, and
`redactTraceRecord` digests with HMAC-SHA-256 via Web Crypto instead of a bare SHA-256, so a
redacted low-entropy field (a PR number, a line number, a repo name) can no longer be
recovered by hashing guesses. A missing or empty key rejects. Digests now carry the
`hmac-sha256:` prefix instead of `sha256:`, so an old unkeyed digest can't be mistaken for a
new keyed one. Equal values still join within an export; exports join only when they share
a key.

Breaking for callers of `redactTraceRecord`, released as a minor under pre-1.0 rules.
`git grep -l redactTraceRecord` finds 0 callers outside this package in titan-platform,
active-work, agent-chat, codewatch, relay and brain.
