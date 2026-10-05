---
"@titan-design/factory": minor
---

`shepherd timeline` gives each `sh-await-verdict` result a `verdict` entry (MERGE, FIX_FIRST or none, with its head, reviewer and transcript span) and each `sh-wake-implementer` or `sh-wake-fix-first` record a `wake` entry, where it listed them as plain steps before. A record that does not parse stays a `step` entry. In the `wake` entry, `request` and `outcome` are now nullable because an implementer wake records no request and the FIX_FIRST counter records no outcome, and `mode` also accepts `live`, which Shepherd already records for a wake sent to a running session.
