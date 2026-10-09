---
"@titan-design/owner-queue": patch
---

`buildOwnerRounds` refuses invalid options before reading any item: a non-loopback `storybookUrl`, `widths` that are empty, repeated or outside 200 to 3840, a NaN, zero or negative `maxQuestions` or `firstRound`, or a blank `unit` throws a `ZodError`. Every manifest is parsed with `RoundSchema` before it is returned, so a returned round is always one round@2 accepts.
