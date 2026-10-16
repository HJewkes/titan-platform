---
"@titan-design/tool-guard": patch
---

splitReading splits a known unquoted expansion under a known custom IFS exactly as bash 5 does (TP-2727 b), so `IFS=,; E='gh,pr,merge,1'; $E` reads as `gh pr merge 1`; an unknown, case-unsure or unmodelled IFS still leaves the word raw.
