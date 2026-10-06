---
"@titan-design/factory": patch
---

Shepherd's `acceptVerdict` records why a reviewer's final message was no verdict, as `malformed: { refusal, writtenAt }` on its `none` result, and `correctionPrompt` builds the one-turn correction message from code-chosen text only. Nothing reads the record yet.
