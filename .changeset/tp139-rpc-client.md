---
"@titan-design/rpc-client": minor
---

New package (TP-139): a browser-safe typed client for titan daemons. `createRpcClient<M>` over a `DataSource`, with `liveSource` (`POST /rpc` plus SSE with reconnect and abort) and `staticSource` (a `titan-snapshot@1` file, answered from recorded calls or a dataset resolver). `exportSnapshot` in the `./node` entry writes the file.
