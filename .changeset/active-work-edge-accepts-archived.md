---
"@titan-design/active-work": patch
---

Accept a `--dep` or `--parent` that names an archived task. The edge check now reads the ids under every initiative's `tasks/archive/` by file name, and an id found in no live or archived file is refused with "no live or archived task file in any initiative".
