---
"@titan-design/queue-mirror": minor
---

`VerdictInput` gains `sender`, the Matrix user who sent the resolving event. The hitl source now passes a resolver to `store.resolve`: by default `{ class: "owner-remote", id: sender, channel: "matrix", confirmEvent: resolutionEventId }`, replaceable with the new `resolverOf` option. A `GateResolverRefused` maps to `rejected`, so the item stays open and is marked refused. `GateAuthorizeInvalid` and `GateStoreSchemaOutdated` are rethrown as configuration faults. Code that calls `QueueSource.resolve` directly must now pass `sender`.
