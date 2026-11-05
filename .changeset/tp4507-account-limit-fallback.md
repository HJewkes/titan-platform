---
"@titan-design/factory": patch
---

Shepherd retries a reviewer, successor or red-main fixer spawn on each later account in the review rotation when the broker refuses it with `reviewer_account_limit` (TP-4507). Other refusals do not fall back.
