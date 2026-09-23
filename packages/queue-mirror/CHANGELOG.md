# @titan-design/queue-mirror

## 0.1.0

### Minor Changes

- ed825dd: New package (TP-316): the `QueueSource` and `MirrorState` ports, `MemoryQueueSource` and `MemoryMirrorState` for tests, `redactPreview` (section 10 decision 3: bearer and basic auth, `token=`, `key=`, `password=`, and 32-plus hex or base64 runs, except a run of exactly 40 hex characters, which is a git commit SHA), and `toItemInput`, which redacts an item and then fits its encoded content under 60,000 bytes, marking it redacted or truncated.

### Patch Changes

- Updated dependencies [52265d6]
  - @titan-design/matrix-bus@0.1.0
