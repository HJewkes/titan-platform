---
"@titan-design/session-read": minor
"@titan-design/session-graph": patch
---

session-read now exports `expandHome(file, homeDir?)`, which expands both a bare `~` and `~/…`; `toAbsolutePath` uses it, so a stored bare `~` path now resolves. session-graph drops its private copy and imports this one.
