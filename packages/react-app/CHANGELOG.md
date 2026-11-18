# @titan-design/react-app

## 0.2.0

### Minor Changes

- 0b40e0f: `RpcProvider` and `createQueryStore` take a `gcMs` option. An unwatched query keeps its result for that long, so a page revisited inside the window shows the kept data at once while a refetch runs behind it. The default of 0 keeps today's drop-a-tick-after-unmount behavior.
- 5fd32b6: `RpcProvider` and `createQueryStore` take an optional `onSettle` observer. It is called once per finished call with `{ command, ms, ok, fromCache }` and never sees arguments or results; a superseded or aborted call is not reported, and an observer that throws cannot break a query.

### Patch Changes

- 05895cd: Type the query store's state as the same status union as `QueryResult`, so `useQuery` needs no cast.
- 9b2057c: Narrow vite plugin and dev-server address types instead of asserting them.
- Updated dependencies [5edd38d]
- Updated dependencies [9b42150]
- Updated dependencies [661cf66]
  - @titan-design/rpc-protocol@0.4.0
  - @titan-design/rpc-client@0.4.2

## 0.1.4

### Patch Changes

- a914535: The test-fixture `registryCaller` and the README's in-process export snippet use registry's `inProcessCaller` instead of a hand-rolled lookup (TP-2464 b).
- Updated dependencies [a914535]
  - @titan-design/rpc-client@0.4.1

## 0.1.3

### Patch Changes

- Updated dependencies [948d6de]
  - @titan-design/rpc-client@0.4.0

## 0.1.2

### Patch Changes

- fb488c6: The query store's `drop` now clears the entry's pending drop timer and deletes only when the map still holds that entry, so a stale timer can no longer delete a re-watched query's newer entry and leave it stuck on `loading`.
- Updated dependencies [f88ac00]
- Updated dependencies [37c2689]
- Updated dependencies [3c5b114]
  - @titan-design/rpc-client@0.3.0
  - @titan-design/rpc-protocol@0.3.0

## 0.1.1

### Patch Changes

- Updated dependencies [dede06c]
  - @titan-design/rpc-protocol@0.2.0
  - @titan-design/rpc-client@0.2.0

## 0.1.0

### Minor Changes

- f2c70e0: New package (TP-140), in the `ui` tier: React data hooks over `@titan-design/rpc-client`, and a Vite preset. `RpcProvider` takes any `DataSource`. `createRpcHooks<M>()` returns `useQuery` (keyed by `snapshotKey`, deduplicated, aborted on last unmount, with `refetch`), `useEvents` (one shared stream per provider), `useInvalidate`, and `useInvalidateOn` (refetch named commands on matching events and after a reconnect). `pageDataSource()`, `embedSnapshot()`, and `readEmbeddedSnapshot()` let one single-file build run live or from a snapshot embedded in the page. `./vite` exports `titanApp({ daemonUrl })`, a dev and preview proxy that keeps the daemon's Host, Origin, and Content-Type guards in force, plus a single-file build.

### Patch Changes

- Updated dependencies [cb3b7e2]
- Updated dependencies [e3128f0]
  - @titan-design/rpc-protocol@0.1.0
  - @titan-design/rpc-client@0.1.0
