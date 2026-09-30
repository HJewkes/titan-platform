---
"@titan-design/session-analytics": minor
---

`costReport` gains `byAction` (each role's cost by action class) and `mechanicalShare` (the cost of the mechanical classes over the window total, and per role), with `actionRules` and `mechanicalClasses` options. `readRequestToolCalls` maps each request to the tool calls it issued with their extracted heads and paths. The renderer prints both tables. The turn-action classifier is now exported, and its default rules match journal files on the basename and merge, retire, agent list and scorer commands only in the program position.
