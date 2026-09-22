# @titan-design/react-app

## 0.1.0

### Minor Changes

- f2c70e0: New package (TP-140), in the `ui` tier: React data hooks over `@titan-design/rpc-client`, and a Vite preset. `RpcProvider` takes any `DataSource`. `createRpcHooks<M>()` returns `useQuery` (keyed by `snapshotKey`, deduplicated, aborted on last unmount, with `refetch`), `useEvents` (one shared stream per provider), `useInvalidate`, and `useInvalidateOn` (refetch named commands on matching events and after a reconnect). `pageDataSource()`, `embedSnapshot()`, and `readEmbeddedSnapshot()` let one single-file build run live or from a snapshot embedded in the page. `./vite` exports `titanApp({ daemonUrl })`, a dev and preview proxy that keeps the daemon's Host, Origin, and Content-Type guards in force, plus a single-file build.

### Patch Changes

- Updated dependencies [cb3b7e2]
- Updated dependencies [e3128f0]
  - @titan-design/rpc-protocol@0.1.0
  - @titan-design/rpc-client@0.1.0
