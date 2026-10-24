---
"@titan-design/decider": minor
---

`validate` now runs `checkUnlock` on the question and the answer and forces escalation when either touches the unlock table or the category is not decidable. It also rejects a reply whose answer differs from the label of `options[optionIndex]`.
