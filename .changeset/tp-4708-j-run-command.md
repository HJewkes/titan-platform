---
"@titan-design/factory": patch
---

Move `runCommand` and `CommandResult` into a `run-command.ts` leaf and `SeatReader` into `shepherd/seat-reader.ts`, and import `DamagedTranscriptError` from `seat-evidence.ts` instead of the `external-review.ts` re-export. Types and module layout only; no behaviour change.
