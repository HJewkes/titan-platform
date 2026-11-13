---
"@titan-design/review-panel": patch
"@titan-design/factory": patch
---

The reviewer brief now asks for checkout cleanup before the final message, and says the final message is the whole review
and verdict, including any `Attests:` and `Follow-ups:` lines. A brief with claimed attestations adds that an `Attests:`
line counts only in the final message. Attests are still read from the final message alone, so a bare repeat of the
verdict block after a full verdict attests nothing. Factory bumps ci-wait to 7 and sh-await-verdict to 3 for the new
brief text in their closures.
