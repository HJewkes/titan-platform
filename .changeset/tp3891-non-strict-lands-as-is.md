---
"@titan-design/factory": minor
---

Land merges a green head as it stands in a repo that does not require up-to-date heads, even after its base moved past the green. There is no land-time update-branch any more. Shepherd no longer chases a busy main through new heads after a MERGE (tp#2054). Strict repos still update a behind head as before.
