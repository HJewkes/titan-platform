---
"@titan-design/render-qa": patch
---

A held finding whose rect lies wholly past a frame edge no longer crashes the qa crop with an empty clip. The crop is the padding-wide band at the nearest edge, and the row is kept.
