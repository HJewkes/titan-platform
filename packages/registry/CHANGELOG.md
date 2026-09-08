# @titan-design/registry

## 0.1.0

### Minor Changes

- 48eace6: Extract the command registry from active-work: generic `BaseContext`, `createRegistry()`
  instances, JSON envelopes with sysexits codes, a never-throws `invokeCommand`, commander-free
  CLI helpers, MCP tool projection via zod 4's `toJSONSchema`, and schema introspection on
  zod's public API instead of `_zod` internals.
