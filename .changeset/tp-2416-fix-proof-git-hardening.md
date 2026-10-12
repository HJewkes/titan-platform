---
"@titan-design/fix-proof": patch
---

Harden fix-proof against a PR head that plants `refs/replace` objects or pathspec magic in the shared checkout: every git call now passes `--no-replace-objects --literal-pathspecs`. A selected test path starting with `-` is an error verdict instead of a vitest flag, and `execSide` resolves even when its out dir cannot be written.
