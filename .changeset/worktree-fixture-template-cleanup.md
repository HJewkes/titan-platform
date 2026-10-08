---
"@titan-design/worktree": patch
---

Test fixture: delete the git templates after each test file. Vitest ends worker threads without emitting `exit`, so every test run left a `wt-template-*` directory (about 2,000 files) in the temp dir.
