---
"@titan-design/factory": minor
---

`shepherd hold` refuses a reason whose class (the text before the first `:`) is not one of `serve-down`, `stalled`, `no-reviewer`, `run-failed`, `visual-gate2`, `g10-review` or `g10-adversary`, and refuses the four factory-defect classes when the reason cites no task ID. A refusal exits 65 and changes nothing; releasing or replacing an existing untyped hold still works. Shepherd CLI verbs now exit with the error envelope's sysexits code instead of 1.
