# @titan-design/rpc-client

## 0.1.0

### Minor Changes

- e3128f0: New package (TP-139): a browser-safe typed client for titan daemons. `createRpcClient<M>` over a `DataSource`, with `liveSource` (`POST /rpc` plus SSE with reconnect and abort) and `staticSource` (a `titan-snapshot@1` file, answered from recorded calls or a dataset resolver). `exportSnapshot` in the `./node` entry writes the file.

### Patch Changes

- Updated dependencies [cb3b7e2]
  - @titan-design/rpc-protocol@0.1.0
