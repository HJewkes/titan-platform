---
"@titan-design/fix-proof": patch
---

Leave tests head skips or marks todo out of `classifyReports`, so a test-only diff whose files hold `it.skipIf` or `it.todo` can be proved by its mutants (TP-4079). A skip inside a failed file, or of a test base passed, still counts as `not-run`. The result line's shape is unchanged.
