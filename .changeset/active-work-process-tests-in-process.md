---
"@titan-design/active-work": patch
---

Run most CLI integration cases in process through commander's `parseAsync`, and start the daemon and stdio MCP tests from the built `dist/cli.js` instead of a `tsx -e` transpile, with session indexing off where a test does not need it. Test-only; no runtime change.
