---
"@titan-design/session-graph": patch
---

Treat prompts in a transcript with no `promptSource` and an `sdk-cli` entrypoint as headless sdk prompts, so older spawned-agent briefs stay out of prompt spans unless `indexSdkPrompts` is set. Lines that carry a `promptSource` keep their classification.
