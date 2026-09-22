# @titan-design/session-analytics

## 0.1.0

### Minor Changes

- fa81bfb: Create `@titan-design/session-analytics` (tier 2): the audit price table, per-request
  pricing, session classification and context/gap bands, as pure functions.

  `priceRequest` returns the five cost components, `costUsd` and `priced`, matching the model
  by longest prefix and then by the latest price row effective at the request timestamp. An
  unknown model returns `priced: false` and zero cost rather than a default rate.
  `classifySession` resolves a session's class from its origin row before its entrypoint, and
  splits human sessions into coordinator and adhoc.
