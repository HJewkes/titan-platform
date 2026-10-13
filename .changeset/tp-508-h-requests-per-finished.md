---
"@titan-design/session-analytics": minor
---

`costPerOutcome` buckets carry `requests` (window requests split over each agent's assignments like `costUsd`) and `requestsPerFinished` (requests over merged plus done, null at zero). The text renderer adds a `req/finished` column.
