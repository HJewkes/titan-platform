---
"@titan-design/session-analytics": minor
---

Add a browser-safe `@titan-design/session-analytics/timeline` subpath. It exports `countAtOrBefore` and the `SessionTimeline` types and imports no session-graph, store-sqlite, session-read or `node:*` module at runtime, so a browser session view can scrub a timeline without the Node-only barrel.
