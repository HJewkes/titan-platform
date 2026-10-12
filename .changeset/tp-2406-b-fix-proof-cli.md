---
"@titan-design/fix-proof": minor
---

Add `fix-proof exec --side base|head --out <dir>` and `fix-proof judge --base-report <file> --head-report <file> [--base-rerun-report <file>]` subcommands, and a `dist/judge.js` entry that can only judge. Every failure, including bad arguments, is still an `error` result line with exit 0.
