---
"@titan-design/session-analytics": minor
---

Add `costReport(db, { since, until, days, top })`, the standing cost report over a session graph, and `renderCostReportText`, which prints it as plain-text tables. The report reads the `request_cost` view on a read-only connection and never writes. It groups cost by token class, account, model, session class, role, initiative, context band and wake cause, crosses wake cause with gap band, and breaks out cold rebuilds, compactions, top sessions, unpriced models and coverage. AskUserQuestion answers count under `human`, with typed text and answers one level down, and mid-loop deliveries are split out of every wake cause. `costReportSchema` is the zod schema of the JSON shape, so zod is now a peer dependency. The package now depends on `@titan-design/session-graph` and `@titan-design/store-sqlite`.
