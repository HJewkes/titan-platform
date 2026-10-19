---
"@titan-design/rpc-protocol": minor
---

Add `EXIT.CANTCREAT` (73) and `RPC_STATUS.CONFLICT` (409). `rpcFailureStatus(EXIT.CANTCREAT)` answers 409, so a command that refuses to overwrite an existing file can say so without a 500.
