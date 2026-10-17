---
"titan-console": patch
---

`rounds.submit` parses round.json with the same strict review-schema 0.3 facade the lister uses, so it refuses any round the Rounds page calls invalid (an unknown top-level key, for one) with "round.json is not a valid round". The loose round@2 manifest parser is gone from `round2-adapter.ts`.
