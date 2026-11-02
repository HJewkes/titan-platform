---
"@titan-design/factory": patch
---

Add `all([...])` in `runner/all.ts` (TP-3108 S3). Every child settles, there is no deadline, and a red step is that child's outcome without cancelling its siblings. Any other error (park, cancel, and authority refusal or denial, though those subclass `StepFailedError`) is rethrown after every child settles. Not yet called by a recipe.
