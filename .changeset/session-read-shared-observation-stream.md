---
"@titan-design/session-read": patch
---

Share one observation stream between the Claude and Codex readers: the backpressure queue, resume check, locator text selection and prefix-digest decode loop now live once. Codex `readCodexText` now resolves a moved source with the same full-identity rule as Claude: a fresh source must match the locator's `sourceId`, harness, format, namespace, conversation and provenance, not `sourceId` alone.
