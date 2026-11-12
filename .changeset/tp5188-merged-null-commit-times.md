---
"@titan-design/active-work": patch
---

The gh PR resolver now asks once about a checked merged PR whose commit times are missing, instead of skipping every checked merged PR. An empty answer stores an empty list, so the PR is not offered again.
