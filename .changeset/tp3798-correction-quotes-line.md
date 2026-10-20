---
"@titan-design/session-read": minor
"@titan-design/review-panel": minor
---

A reviewer verdict correction now quotes the line that made the verdict malformed (TP-3798). `session-read` exports `refusedLines(text, refusal)`, which returns the non-canonical `Verdict:` lines (for `multiple_blocks`) or labelled CI-policy lines (for `ci_policy_malformed`); the reading itself is unchanged and still fails closed. `review-panel` records them as `malformed.quotes`, and `correctionPrompt` takes `quotes`, shows up to three of them cut to 120 characters inside `MAX_CORRECTION_PROMPT_CHARS`, and asks the reviewer to reword or remove them. `CI_POLICY_RULE` now says no other line may start with "CI policy" or "Verdict", markdown headings such as `**CI policy:**` included.
