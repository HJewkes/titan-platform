---
"@titan-design/tool-guard": patch
---

Stop swallowing `ClassifyContext` errors. A `readHead` that throws now reads as an unknown, protected head, so `git push origin HEAD` and `git merge` no longer pass as if no branch were checked out. A `readLink` or `readScript` that throws now reaches the caller, where the hook denies the Bash command, instead of reading as no link or no script.
