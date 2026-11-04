---
"@titan-design/factory": patch
---

Move the Verbs, CliIo and CliDeps types into a `cli-types.ts` leaf, which breaks the cli.ts import cycle. Types only; no behaviour change.
