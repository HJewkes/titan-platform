# @titan-design/registry

## 0.6.0

### Minor Changes

- b6ce883: Add optional MCP schema input/output and override controls plus product-specific invalid-argument formatting. Existing projection and validation defaults remain unchanged.

  Expose CLI value placeholders, variadic array positionals and explicit option defaults so consumers can preserve their existing help and argv contracts.

  Breaking for array-typed positionals: they now render as variadic (`<name...>`, `[name...]`) and take every remaining argument, where before they took one value wrapped into an array. An array positional must be the last positional, or Commander throws at setup. An omitted variadic is left out of the args instead of arriving as `[]`, so zod defaults apply and the CLI matches MCP and HTTP.

### Patch Changes

- b6ce883: Render exact true literal CLI fields and optional wrappers as bare switches, preserving value placeholders for other literal and wrapper forms.
- 820d4d2: Clear the typed-lint baseline for registry: the error-code read and the array-element kind now narrow instead of asserting. No exported type or behaviour change.
- Updated dependencies [5edd38d]
  - @titan-design/rpc-protocol@0.4.0

## 0.5.0

### Minor Changes

- 54b6d69: Add `inProcessCaller(registry, context, options?)`: call commands by name in process, with an unknown name returning an `EXIT.USAGE` error envelope instead of throwing.

## 0.4.0

### Minor Changes

- 1893149: Declare `Command.run` as a function-typed property instead of a method, so its context parameter is checked contravariantly. A command whose `run` needs a narrower context than `Ctx` no longer typechecks as a `Command<…, Ctx>`, an `AnyCommand` or an entry in a wider registry; before, the method's bivariant parameter let it through and it ran without the fields it reads. A command written for `BaseContext` still serves any product's registry. `commandToTool` and the CLI option helpers now take `AnyCommand<never>`, which accepts a command of any context, since they never call `run`. A consumer that relied on the bivariance gets a compile error at the widening.

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
