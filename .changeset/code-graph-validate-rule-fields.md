---
"@titan-design/code-graph": patch
---

`validateRules` now rejects a rule whose `severity` is not `"error"` or `"warning"`, whose metric `kind` is outside `NodeKind`, or whose `exclude` is not a string array. These used to load silently: `"Error"` counted as a warning so the check still passed, a misspelled `kind` matched no node, and a string `exclude` was dropped.
