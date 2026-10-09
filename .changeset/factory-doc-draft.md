---
"@titan-design/factory": minor
---

Add the doc pilot's task source, claude-print draft route and pure draft check. The task source reads a docs task's title, done_when and status over the active-work rpc and never its notes. The draft route runs one sonnet turn through an injected agent runner and parses the reply with zod. `checkDraft` refuses unchanged content, a non-Markdown path, front-matter edits, a removed section, owner data in an added line and a line delta over the bound.
