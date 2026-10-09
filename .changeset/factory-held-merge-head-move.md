---
"@titan-design/factory": patch
---

Notice a push while a Shepherd run waits: a merge step held at a head the pull request has moved past ends with no merge, so the run takes CI and review at the new head and meets the same hold there, and resync answers such a step for a run no runtime holds. A `stuck-behind` gate whose head moved is superseded like the other head gates.
