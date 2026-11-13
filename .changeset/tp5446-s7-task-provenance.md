---
"@titan-design/pm": minor
"@titan-design/active-work": patch
---

Add the task provenance fields `class`, `serves`, `source`, `source_ref`, `filed_by`, `rank`, `done_reason`, `blocked_on` and `field_origin` to `TaskSchema`, all optional on read, and `TaskRequireSchema` for a brief's `task_require` list, which active-work's brief schema now reads (TP-5446 S7).
