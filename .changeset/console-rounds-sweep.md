---
"titan-console": minor
---

Withdraw stale review rounds without doing it by hand (TP-3990). A `round.json` may list `supersedes: ["<round-id>", ...]`, a console-owned field lifted off before review-schema's strict parse. Importing or answering that round withdraws each named round that is still open as `superseded-by:<id>`; an answered target is reported `kept-answered`, and an unknown id is reported, never refused. `titan-console rounds sweep [--dry-run|--apply] [--json] [--decisions <path>]` runs that rule over every round and lists the open rounds a decisions file cites as answered or resolved, with the line. A dry run, the default, writes nothing; only `--apply` withdraws, as `answered-elsewhere`. `rounds withdraw` also accepts `superseded-by:<id>`.
