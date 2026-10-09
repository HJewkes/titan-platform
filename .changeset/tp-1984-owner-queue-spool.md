---
"@titan-design/owner-queue": minor
---

Add the `@titan-design/owner-queue/spool` subpath, the on-disk store of record for deposits and their answers. `writeDeposit(dir, deposit)` validates against `ownerItemDepositSchema`, refuses a deposit over `MAX_DEPOSIT_BYTES` (64 KB), and files `<asker>-<depositId>.json` at mode 0600 through a temp file, once: a repeated `depositId` from one asker keeps the first file and returns `created: false`. `readSpool(dir)` returns every valid deposit as an open `OwnerItem` (opened at the file's mtime) plus a `rejects` list of `{ file, reason }`, and one bad file never stops the read. `writeAnswer(dir, id, answer)` and `readAnswer(dir, id)` keep `<id>.answer.json` beside the deposits. File names percent-encode every byte outside `[A-Za-z0-9_]`, so an untrusted asker or depositId cannot write outside the spool. The root export still does no I/O.
