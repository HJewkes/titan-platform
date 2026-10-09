# @titan-design/registry

## 0.3.3

### Patch Changes

- 45f05b1: Correct the README dependency claim: registry depends on rpc-protocol as well as zod.
- Updated dependencies [37c2689]
- Updated dependencies [3c5b114]
  - @titan-design/rpc-protocol@0.3.0

## 0.3.2

### Patch Changes

- 1712421: `flagToKey` and `readCommanderOption` now drop a trailing `<name>`, `[name]` or variadic `<names...>` placeholder and accept a short alias form such as `-s, --spawner <name>`. Before, `--spawner <name>` keyed as `spawner <name>` and the option was never read.

## 0.3.1

### Patch Changes

- Updated dependencies [dede06c]
  - @titan-design/rpc-protocol@0.2.0

## 0.3.0

### Minor Changes

- e3128f0: Add `CommandMapOf<T>`, a type-only helper that derives the `CommandMap` a typed client is generic over from commands keyed by name (TP-139). Browser code imports the result with `import type`, so neither zod nor registry reaches its bundle.

### Patch Changes

- cb3b7e2: The wire contract now comes from `@titan-design/rpc-protocol`. `registry` re-exports `JsonEnvelope`, `EXIT`, `successEnvelope`, and `errorEnvelope`, and `daemon` re-exports `SseMessage`, so existing imports keep working. The bytes on the wire are unchanged (TP-138).
- Updated dependencies [cb3b7e2]
  - @titan-design/rpc-protocol@0.1.0

## 0.2.0

### Minor Changes

- 4ce40d1: CLI options for array-typed fields now repeat instead of taking a single comma-separated
  value: `--tag a --tag b` yields `["a", "b"]`, with each element coerced by the array's
  element kind. Adds `collectOptionParser`, commander's accumulator for these fields, and
  `arrayElementKind` for schema introspection. `coerceCliValue` no longer splits a
  comma-separated string for an array field.

## 0.1.0

### Minor Changes

- 48eace6: Extract the command registry from active-work: generic `BaseContext`, `createRegistry()`
  instances, JSON envelopes with sysexits codes, a never-throws `invokeCommand`, commander-free
  CLI helpers, MCP tool projection via zod 4's `toJSONSchema`, and schema introspection on
  zod's public API instead of `_zod` internals.
