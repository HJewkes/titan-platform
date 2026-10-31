# @titan-design/fleet-panel

## 0.1.0

### Minor Changes

- 5d90346: Add the fleet-panel mod: `/fleet` docks a pane of running agent-chat agents (status, model, account, task and PR, last Status report, context fill, session spend) under per-account 5h and 7d usage and the slot count, fed by `titan-fleet-feed`.

### Patch Changes

- d4ad311: Use the shared narrowing helpers from `@titan-design/rpc-protocol/narrow` in place of local copies. Behaviour is unchanged.
- Updated dependencies [5edd38d]
  - @titan-design/rpc-protocol@0.4.0
