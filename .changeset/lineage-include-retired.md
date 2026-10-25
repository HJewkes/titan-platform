---
"@titan-design/agent-dispatch": patch
"@titan-design/factory": patch
---

Walk retired generations in Shepherd's reviewer independence proof (TP-4132). agent-dispatch adds `listAgentLineage`, which reads `agent ls --json --include-retired`, parses each row's `retired` marker, and on an agent-chat that predates the flag falls back to the plain roster marked incomplete. Factory proves independence against that lineage, so the spawner of a seat's retired first generation counts as an ancestor; an incomplete lineage proves nothing. Retired rows feed the proof only: the roster that names, resumes and finds reviewers never includes them.
