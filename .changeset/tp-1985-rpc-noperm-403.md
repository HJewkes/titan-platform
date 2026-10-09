---
"@titan-design/rpc-protocol": minor
"@titan-design/daemon": patch
---

Add `EXIT.NOPERM` (77) and `RPC_STATUS.FORBIDDEN`. `rpcFailureStatus` maps a command that refuses its caller with `NOPERM` to 403, so `POST /rpc/:name` answers 403 for it instead of 500.
