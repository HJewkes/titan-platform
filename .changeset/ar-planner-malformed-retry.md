---
"@titan-design/autoresearch": minor
"@titan-design/factory": patch
---

A planner answer whose final message held no JSON is now reported on the plan step as `malformed` and gets the same one resumed retry a quota miss does, with the parse error as its violation, instead of failing the run. The factory reads agents' final messages whole, so an answer past 16 KiB keeps its closing fence.

`titan-factory autoresearch plan-dry-run <target>` runs only a round-1 planner turn on an empty digest and checks its ops against the parse, the queue-ops schema and the quotas, with no pin, baseline or implementer.
