---
"@titan-design/factory": patch
---

`/health` now reports `build: { sha, behindMain }`: the git sha baked in at build time and how many commits main is ahead of it, from a cached `gh compare`. `service status` prints both.
