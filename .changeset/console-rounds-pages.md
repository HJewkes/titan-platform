---
"titan-console": minor
---

Add the `#/rounds` read pages. `rounds.list` and `rounds.get` (class read) serve the review rounds under `TITAN_CONSOLE_ROUNDS_DIR` (default `<state>/rounds`), one `<round-id>/round.json` each, validated with `RoundSchema` from `@titan-design/review-schema`. An invalid manifest, round@1 included, is listed with the schema's reason. While an `after-answer` round is unsent, `rounds.get` strips every question's recommendation. `#/rounds` lists open and sent rounds; `#/rounds/<id>` renders each question with its options and keys 1-9 choosing one, through a reusable `RoundQuestion` component. A round with frames shows "design round: open in the harness". Round ids are plain names, symlinked round directories and files are refused, and `round.json` is read only up to 1 MiB.
