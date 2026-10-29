---
"@titan-design/active-work": patch
---

The CLI reference generator spawns each command's `--help` once instead of twice, halving the time `prepack` and the cli-reference test spend. The generated reference is unchanged.
