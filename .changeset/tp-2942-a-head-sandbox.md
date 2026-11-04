---
"@titan-design/fix-proof": patch
---

`execSide` on the head side now honours `sandboxUser`: the head's install, build and vitest run through the sandbox after the tree is chowned, and a setup failure writes a `head: sandbox setup failed` marker instead of running unsandboxed.
