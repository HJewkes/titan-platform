---
"@titan-design/session-analytics": patch
---

`parseDenials` reads classifier refusals from session-read's `decodeClaudeToolLines` observations, joined to the refused call by call id, instead of its own transcript decoder. A refusal whose result carries no call id is no longer counted.
