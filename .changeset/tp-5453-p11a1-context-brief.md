---
"@titan-design/active-work": minor
---

Add `context.brief` (TP-5453 P11a-1). It renders the related-context section of a spawn brief as finished
text within a UTF-8 byte budget (default 2600, max 4000): at most three workspace ids, ranked with the agent's
view whoever calls, over every registered workspace class except transcripts and initiative briefs. A missing
index gives empty text and a `degraded` entry. With `trigger` set, the rendered refs are logged as served in
the same call.
