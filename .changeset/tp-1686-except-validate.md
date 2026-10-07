---
"@titan-design/code-graph": patch
---

A forbid-import `except` entry now matches one exact path unless it contains `*`, instead of any path containing it, and an empty `except` entry is refused when rules load instead of silently disabling the rule.
