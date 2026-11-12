---
"@titan-design/review-burden": patch
---

Read `git diff --numstat -z` in the bin, so a changed path with a space or a non-ASCII character keeps its path class instead of arriving quoted.
