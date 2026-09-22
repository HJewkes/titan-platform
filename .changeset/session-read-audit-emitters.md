---
"@titan-design/session-read": minor
---

Emit the `inbound`, `context_block` and `signal` audit events. User lines and `queued_command` attachments give an `inbound` with its wake cause. User text, tool results, images, assistant blocks and attachments of 256 characters or more give `context_block` rows. Tool calls give signals, including `pr_merge` and an active-work `Skill` call as `task_wrap`. `EXTRACT_VERSION` is now 2. The wake-cause, tool-family and injected-marker classifiers are exported, and the audit types now come from them rather than from duplicate copies.
