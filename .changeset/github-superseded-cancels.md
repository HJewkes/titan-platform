---
"@titan-design/github": minor
---

Add `withoutSupersededCancels`, which drops a cancelled run only when a newer run of the same name, head sha and app exists. A superseded failure and a lone cancel still count.
