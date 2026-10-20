---
"@titan-design/factory": patch
---

A console Send back leaves out the comments of answers the owner marked Follow-up. The note for the fixer now skips every question listed in the round's `follow-ups.json`; the file is read with the console's own limits (regular file, 64 KB, no symlink), and a missing or invalid file changes nothing. Follow-up answers never block or alter a Ship decision.
