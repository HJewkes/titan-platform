---
"@titan-design/owner-queue": minor
"@titan-design/factory": patch
"titan-console": patch
---

Add `promptLine` and `PROMPT_LINE_BREAK` to `@titan-design/owner-queue`: one cleaner for author- or agent-written text bound for an owner prompt, which drops ANSI escape sequences, C0 and C1 controls and every format character (bidi overrides and isolates, zero-width and tag characters) and flattens CR, LF, NEL, U+2028 and U+2029. The D21 ci-policy card, the console's decisions-file line and the Shepherd wake brief's review comments now all use it, so the decisions line also drops bidi and escape sequences, the wake brief strips them from comment paths and bodies (a verdict line behind a bidi override is now quoted), and the ci-policy card also drops tag characters and soft hyphens.
