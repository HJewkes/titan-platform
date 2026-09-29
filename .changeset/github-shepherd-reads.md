---
"@titan-design/github": minor
---

Add `listPrFiles` (every page, `previousPath` on a rename, throws `FileListTruncatedError` when GitHub's 3,000-file cap cut the list), `compareFiles` (`mergeBaseSha`, changed paths and `truncated` at GitHub's 300-file and 250-commit caps) and `upsertComment` (lists first, posts once per marker, counts only the authenticated user's comments with the marker alone on a line), each in `fakeGitHub`.
