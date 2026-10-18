---
"@titan-design/factory": patch
---

Add `POST /owner/console-action`, mounted when `shepherd.consoleAnswers.actionsDir` is set. It resolves an approve-merge gate (the `shepherd-release` Version Packages gate included) as owner-remote from the console inbox's action record, read O_NOFOLLOW and size-capped from that dir; the body names only `{ actionId }`. Hardware, after-stages and other gates are refused, as is a record whose head GitHub has moved past.
