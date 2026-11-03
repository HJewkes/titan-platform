---
"@titan-design/explainer": minor
---

Spoken-track device lint (TP-4327). Q-V12, digits in a spoken line, is now an L0 error with a repair hint that shows the line with its numbers spelled. New Q-V14 fails a spoken line that carries a print device (parentheses, slashes, "e.g.", "i.e.", "etc.", "&", "%", unit symbols) or a file path, code token or acronym with no spoken alias. A lexicon entry or a `[word](/phonemes/)` override is an alias; a `[word](=reading)` declaration is not. Stage versions: script x13, rewrite x8, eval x8.
