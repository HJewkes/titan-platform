---
"@titan-design/session-read": minor
---

Add pure classifiers for the session cost audit: `toolFamily` (tool name to
family and MCP server), `classifyInbound` (what woke the session, from one
`user` record or a `queued_command` attachment), and the shared
`injected-markers` list. Not exported from the package entry point yet.
