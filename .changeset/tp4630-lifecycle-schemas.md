---
"@titan-design/agent-protocol": minor
---

Add the `@titan-design/agent-protocol/lifecycle-schema` subpath: `executionRecordSchema`, `executionTransitionSchema` and the `ExecutionRecordSchema` / `ExecutionTransitionSchema` defaults, zod schemas for stored execution rows. Objects are loose, so keys a newer writer added survive a parse, and the `ExecutionRecord` / `ExecutionTransition` types are checked against them at compile time.
