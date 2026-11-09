---
"@titan-design/agent-protocol": patch
---

The id-component encoder and the SHA-256 hex regex now live once in an internal module, `id-encoding.ts`, and `index.ts`, `trace/ids.ts` and `lifecycle-targets.ts` import them. `SHA256_PATTERN` stays exported. The error message for an empty identity component now reads "id components must be nonempty strings", as the trace ids already did.
