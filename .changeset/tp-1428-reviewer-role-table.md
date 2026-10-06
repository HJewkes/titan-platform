---
"@titan-design/factory": patch
---

Shepherd's reviewer profile now comes from a role table by PR class: a registered `security` kind gets the g10 profile and every other PR the standard one. The optional `shepherd.review.roles` sets them; with no table every class keeps `review.profile`.
