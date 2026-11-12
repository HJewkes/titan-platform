---
"@titan-design/github": patch
---

`compareFiles` and `compareCommits` list `previous_filename` beside `filename` for a renamed entry, so a rename counts as touching both paths. Truncation still compares the entry count with `COMPARE_FILE_CAP`. The fake takes a `renames` map on a compare input and agrees.
