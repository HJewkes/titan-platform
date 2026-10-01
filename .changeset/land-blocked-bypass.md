---
"@titan-design/factory": patch
---

Land treats a `blocked` pull request as green once its required checks pass and the only block is an approval rule the caller can bypass, so Shepherd runs leave the ci phase instead of polling to timeout.
