---
"@titan-design/code-graph": minor
---

Split cognitive complexity into logic and markup for functions that render JSX. `cognitiveSplitOf` returns the total and the share charged inside JSX `{…}` expressions. New metrics `symbol_markup_cognitive`, `symbol_logic_cognitive` and the file-level `logic_cognitive_max` are written where `symbol_jsx_depth > 0`; hook callbacks stay logic, only callbacks inline in JSX count as markup. `INDEX_VERSION` is now 0.23.0.
