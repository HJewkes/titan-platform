---
"@titan-design/active-work": minor
---

`context.brief` adds a code section (TP-5453 P11b-2): one hop of imports around the files the assignment
names, plus the done_when and owns paths of each task key it names in an agent-visible initiative, at most six
lines in an 800-byte share. Neighbours come from codewatch's `node.neighbors` over loopback; when codewatch is
not answering, the named files' relative imports are read from the new optional `repoRoot` checkout and the
result carries `degraded: code/no-snapshot`. The section stops at 800 ms. The workspace, code and session
sources now run concurrently under one 2,000 ms deadline, and a source that misses it is listed as a timeout.
