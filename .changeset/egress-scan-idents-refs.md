---
"@titan-design/egress-scan": minor
---

Scan each commit's author and committer name and email, and the ref names a pre-push sends. A finding names the field (`author.name`, `committer.email`, `push line 1 local ref`). Minor, not patch: pushes that passed before can now be refused, and `ScanSource` gains an `idents` field and `IdentField` export. Docs now state that UTF-16 text is not scanned.
