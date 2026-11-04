---
"@titan-design/factory": minor
---

Add `titan-factory shepherd visual-week --repo owner/repo` (TP-4761 S3). It prints the weekly Ship batch round spec for the repo's pending visual-path approve-merge gates: one merge-bound pick-one question per gate at a current, unheld head, bound to the gate's own head, with the gates it left out and why. It is read-only and resolves no gate; the console's Ship answers the batch through the existing round sweep.
