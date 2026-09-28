---
"@titan-design/agent-protocol": minor
---

Add the `./trace` subpath: `titan.trace/v1` zod schemas for run, attempt, call, gate, artifact and cost records plus the envelope and `TranscriptSpan`, strict and loose parsers, the id helpers `commitRef`, `policyGateId` and `costId` with id patterns, `TRACE_FIELD_PRIVACY` and `redactTraceRecord`, and fixtures for a synthetic documentation run. `zod` 4 is an optional peer dependency; the root entry is unchanged and never imports it.
