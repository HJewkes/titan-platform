---
"@titan-design/daemon": minor
---

`/events` is bounded. A new `eventLimits` option on `startDaemon` and `buildHttpApp` sets `maxSubscribers` (default 64, counted across both listeners; one more stream answers 503) and `maxQueued` (default 256 unwritten broadcasts per stream; one more disconnects that stream, so a slow client reconnects instead of silently missing a frame). `EventLimits` and `DEFAULT_EVENT_LIMITS` are exported.
