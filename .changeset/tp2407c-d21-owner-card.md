---
"@titan-design/factory": patch
---

A Shepherd approve-merge gate on a reviewer's `CI-policy: weakened` line is now the D21 owner card. The question and summary name Class D21 and the weakened keys. The prompt shows, for each changed `.github/` file, the lines matching those keys that were removed and added between the base branch and the head; the merge-evidence step reads these lines with `getFile`. Lines are stripped of escape sequences and control characters, cut at 160 characters, and capped at 20 per file. A failed file read still gates and is named among the unread facts. The `other` key has no matcher, so the card sends the owner to the diff for it.
