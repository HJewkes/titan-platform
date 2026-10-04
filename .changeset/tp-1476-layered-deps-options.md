---
"@titan-design/code-graph": minor
---

`layered-deps` accepts `excludeRoles`, validated like the metric rules' option: an import is dropped when its source or destination file has an excluded role. Each violation's message now names the source and destination files as well as their packages and layers.
