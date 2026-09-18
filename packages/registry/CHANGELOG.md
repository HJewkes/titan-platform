# @titan-design/registry

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
