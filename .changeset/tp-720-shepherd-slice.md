---
"@titan-design/factory": minor
---

`shepherd register --slice <label>` marks a PR as one slice of a multi-slice task. When it lands, cleanup appends "<label> landed in <repo>#<n> at <merge sha>" to the task's notes and leaves the task open. Without `--slice` the task is closed as before.
