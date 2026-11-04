---
"@titan-design/factory": minor
---

Shepherd's merge guard now reads `shepherd.visualTier[repo]` (off, shadow or on) at each evidence step and records the visual tier on the merge evidence and its comment. Under `on`, a tier-1 non-rendering head clears the visual-path row so MRG-AU-RV merges it; tier 2 keeps the visual-path gate. Shadow only records, and off changes nothing.
