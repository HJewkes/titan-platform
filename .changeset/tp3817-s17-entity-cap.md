---
"@titan-design/explainer": patch
---

The rewrite guard no longer rejects an entity that moved into an appended label (matched as a whole word, so "F1" is not carried by "F12"), and no longer applies the sentence cap to a sentence that appears verbatim in the original beat. A sentence with one word changed is still capped.
