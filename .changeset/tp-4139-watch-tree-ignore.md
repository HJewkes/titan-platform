---
"@titan-design/daemon": minor
---

`watchTree` takes an `ignore` list of directories under the root. It attaches no watcher to them and their events never fire `onChange`, so a host can keep its own state inside the watched tree.
