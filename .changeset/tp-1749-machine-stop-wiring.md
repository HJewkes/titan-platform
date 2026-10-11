---
"@titan-design/factory": patch
---

Wire Shepherd's machine-stop watch in production. `configuredRoutes` builds one watch over the factory's machine reading and spawn limits; the spawn gate notes every machine-stop breach it reads (not a pace or build-limit deferral), the reviewer dispatch notes every broker `machine_hold` refusal, and the review wiring carries the watch, so a reviewer that goes silent while the stop held is retried as a throttled round.
