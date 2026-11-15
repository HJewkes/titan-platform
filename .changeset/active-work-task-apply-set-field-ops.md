---
"@titan-design/active-work": minor
---

`task apply` accepts `set_bet`, `set_estimate`, `set_fold`, `set_kind`, `set_cos`, `set_area` and `set_due`. Values are checked against the task schema, the category registry (read once per run) and the plan store (each bet id looked up once); a bad value fails only its own line. An unknown op now lists the valid ones.
