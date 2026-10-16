---
"@titan-design/fix-proof": patch
---

Every fix-proof git call now also passes `-c core.fsmonitor=false -c core.hooksPath=/dev/null`, and the plan's `git diff` passes `--no-ext-diff --no-textconv`, so an fsmonitor, hook, external diff or textconv program that PR code writes into the shared `.git` never runs.
