---
"@titan-design/agent-dispatch": minor
---

`@titan-design/agent-dispatch/brief` now carries the return contract (the implementer and reviewer blocks, with and without the Shepherd handoff), `withReturnContract` and `contractOf`, the standing rules, and `lintBrief` with `repoVisibilityReader`, ported from agent-chat. The block text is byte-identical to agent-chat's, pinned by a golden fixture. Profiles are structural (`ContractProfile`), and `repoVisibilityReader` takes its git and gh runners from the caller.
