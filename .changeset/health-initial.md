---
"@titan-design/health": minor
---

Add `@titan-design/health` with the health/v1 contract after draft-inadarei-api-health-check, with `checks` keyed `component:measurement` and holding arrays as the draft does: `healthReportSchema` (strict write, product keys kept), `parseHealthReport` (loose read: legacy `ok`, the draft's aliases and unknown fields; a mistyped known field is dropped and named in `ignored`; never better than the worst check), `worstStatus`, and the strict `healthSampleSchema` for one stored probe result. zod is a peer dependency.
