---
"@titan-design/factory": patch
---

Shepherd cleanup in the default `keep` task-close mode now closes a task when a registered slice's merge leaves every slice of the plan's burndown-slices block noted landed. Before, only the slice note was written and the task stayed open. Unlanded slices, an unreadable slices block and epic/slices tags still hold it open.
