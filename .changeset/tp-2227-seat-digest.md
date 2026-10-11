---
"@titan-design/factory": minor
---

Add the Shepherd seat digest: `titan-factory serve` sends each seat one agent-chat message whenever its state changes, listing every open gate with its exact `titan-factory gate resolve` command, every `ci-failed` or `sh-sent-back` fix round the seat was told about with no fixer woken, and runs that finished since the last digest. An unchanged state sends nothing, and what each seat was last told is kept in `seat-digest.json` beside the factory database so a restart does not resend. The seat notice record now carries its gate and head.
