---
"@titan-design/eslint-plugin": minor
---

Every rule now names the review-finding class keys it catches in `meta.docs.classes`, so a review step can skip a class a lint rule already covers. The exported rules are typed as `Rule.RuleModule` plus that field.
