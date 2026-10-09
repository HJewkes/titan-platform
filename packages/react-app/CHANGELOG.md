# @titan-design/react-app

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
