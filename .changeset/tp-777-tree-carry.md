---
"@titan-design/factory": minor
---

Shepherd gains the `sh-carry:<head>` step, a tree-carry probe: `carry({ repo, baseRef, fromHead, head })` answers `{ equal: true }` only when `head` is a two-parent merge, `fromHead` is its ancestor, the second parent is on `baseRef`, and `git merge-tree --write-tree` of the second parent and `fromHead` is clean and equals `head`'s tree. It runs in a factory-owned bare cache at `<stateDir>/git-cache/<owner>/<name>.git`, which `serve` binds to its state dir. Any fetch or git failure answers `equal: false` with a reason. Nothing calls the step yet.
