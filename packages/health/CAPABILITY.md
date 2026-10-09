# health: use this when

<!-- One to three sentences for a reader deciding whether to reuse this or build something new. Feeds CAPABILITIES.md. -->

You emit or read a health route's payload and want one open contract: `healthReportSchema` for health/v1 (pass, warn or fail with named checks, after draft-inadarei-api-health-check) and `parseHealthReport` to read any payload, legacy `ok`-only ones included, without ever reading better than its worst check. `healthSampleSchema` is the strict row for storing one probe result. `probeHttp` takes one such sample of a health route, with a timeout and a pid/port identity check, and never throws for a target that is down. To serve the health route itself, use daemon.
