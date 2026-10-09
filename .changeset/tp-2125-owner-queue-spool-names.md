---
"@titan-design/owner-queue": patch
---

Spool file names now escape A-Z, so `Bob` and `bob` no longer share a file on a case-insensitive filesystem. A lone surrogate in an asker, depositId or item id is refused with a `RangeError` rather than given U+FFFD's name. `writeDeposit` throws `SpoolNameCollisionError` instead of answering `created: false` when the name holds a different deposit. Deposits and answers filed under the old unescaped names are still read. `depositFileNames` and `answerFileNames` list both forms, and a repeat of an old deposit still answers `created: false`.
