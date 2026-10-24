---
"@titan-design/decider": patch
---

The shadow scorer now reports `CategoryScore.bulk`, the number of in-window bulk owner rows per category. A bulk row still adds no sample, agreement, baseline or missed redirect, so a category made only of bulk rows has zero samples and is never recommended for auto.
