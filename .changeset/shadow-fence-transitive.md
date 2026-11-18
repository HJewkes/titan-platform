---
"@titan-design/factory": patch
---

Make the shadow dispatcher fence test follow local imports transitively, with a ratchet allowlist of the edges TP-6157 removes, and move `activeWorkOrigin` to its own module so fenced files no longer pull in the launch-capable cleanup ports.
