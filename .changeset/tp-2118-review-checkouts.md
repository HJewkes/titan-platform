---
"@titan-design/review-panel": minor
"@titan-design/factory": minor
---

Move Shepherd review checkouts to the titan-factory app data dir. `reviewerBrief` now requires `checkoutRoot`, puts the head and base checkouts under `<checkoutRoot>/<run>`, and tells the reviewer to remove that whole dir. Shepherd also removes the run dir when the verdict step ends, and the stale-checkout sweep reads the same root.
