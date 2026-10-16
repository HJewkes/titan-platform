---
"@titan-design/tool-guard": patch
---

Add internal URL-path helpers `hasDotSegment` and `curlSquashed`, which resolve `.`/`..` segments (including `%2e` spellings) the way default curl does (TP-2924 a). Not wired into the hook yet.
