---
"@titan-design/active-work": patch
---

Context mode reads a span's tier-2 text through `readLocatorText`, so a span running past the end of a shrunk file drops the tier instead of showing partial text.
