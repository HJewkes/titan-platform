# @titan-design/matrix-bus

## 0.1.0

### Minor Changes

- 52265d6: New package (TP-312): the Matrix client-server API over global `fetch` with no matrix-js-sdk. `AppserviceClient` (send, state, messages, whoami, join, register, `m.login.application_service` login and a `syncLoop` async iterator that hands back `since` per batch), the `io.titan.item` codec inside `m.room.message`, `foldResolution` for owner reactions, replies and `io.titan.resolution` events, the 60,000-byte `assertSendable` guard, `queuePowerLevels` and `bootstrapQueueRoom` for an owner-created v12 `#queue`, `loginPassword`, and `renderRegistration` for a per-machine `@ac-<machine>-.*` appservice.
