---
"titan-console": minor
---

A design round's frames now take a verdict and a comment. Each strip frame and each frame a question draws above itself shows Chosen, Rejected and Maybe (a second press clears the verdict) and a comment box. Pressing a frame makes it the active one: `c`, `x` and `m` set its verdict and `u` clears it, while digits answer only an active question. Send answers posts every frame that holds a verdict or a comment as a `rounds.submit` `variants` entry. The `feedback.json` write cap rises from 64 KiB to 256 KiB, so a 24-frame round with long comments and pins is no longer refused whole.
