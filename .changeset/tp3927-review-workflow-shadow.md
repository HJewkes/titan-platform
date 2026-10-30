---
"@titan-design/factory": minor
---

`shepherd.review.workflow` takes `off`, `shadow`, `on:preflight` or `on`, and an absent key means `off`. Under `shadow`, each review round records `sh-review-shadow:<head>`: review-workflow's preflight decision, the round's failure classes and the policy action it would take. It is computed from the round's records and starts no session. `on:preflight` and `on` run as `off` with a logged reason until they ship. `shepherd stats --review-shadow` reports the shadow per repo and ISO week.
