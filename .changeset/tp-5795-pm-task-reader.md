---
"@titan-design/pm": minor
---

`@titan-design/pm/node` adds `readInitiativeTasks(activeRoot, slug, { archive })`, the one reader for an initiative's task files. It returns parsed rows in filename order (live, then archive on request), unparsable files with a reason instead of throwing, and `missing` when the initiative has no `tasks/` folder.
