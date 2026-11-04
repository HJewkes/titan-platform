---
"@titan-design/github": patch
---

- **Git fixtures on test-kit (TP-4485).** `git-merge-tree.test.ts` copies a test-kit template repository per test and writes its branches with one `withHistory` fast-import. No runtime change.
