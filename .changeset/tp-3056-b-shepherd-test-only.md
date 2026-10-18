---
"@titan-design/factory": patch
---

Shepherd's test-only diff reading now flags a PR that deletes a test or changes no test, and reads every listed path's blob first: a gitlink, a large file, a missing blob or more than 100 paths reads `unread`. A move into test-only is refused for every reading but `test-only`.
