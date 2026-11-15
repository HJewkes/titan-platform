---
"@titan-design/factory": patch
---

Write one freeze per plan-freeze-set tap under concurrent posts and crash replay: the set checks the plan store for the tap's own earlier freeze under the plan lock (TP-5624).
