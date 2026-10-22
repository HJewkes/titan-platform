---
"@titan-design/fix-proof": patch
"@titan-design/tool-guard": patch
---

The mutants side now parses and pairs a diff's `*.mutations.json` specs even when the diff changes source, and runs each mutation through `checkMutation` against head there (its new optional `at` names that commit in the error). Any refused spec, or on a source diff any failure reading one, also writes `mutants.refused`, which fails the fix-proof-mutants job. Before, a source diff skipped its specs unread, so over-cap specs landed. tool-guard: one sidecar mutation name shortened to the 80-character cap; test material only.
