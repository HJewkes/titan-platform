---
"@titan-design/active-work": patch
---

The CLI reference generator renders every command's help in process from the built program instead of spawning the CLI once per command, so `prepack` and the cli-reference test take well under a second. The generated reference is unchanged.
