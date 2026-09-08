---
"@titan-design/daemon": minor
---

Extract the daemon host from active-work: a hono app serving `/health`, `/version`,
`/events`, and `/rpc/:name`, with MCP spliced in at `/mcp`. Product concerns become
parameters (`registry`, `createContext`, `stateDir`, `port`, `watchRoot`, `health`,
`mountRoutes`, `formatError`, `logger`), and `startDaemon` returns a closable handle so the
lifecycle is testable and never calls `process.exit`.
