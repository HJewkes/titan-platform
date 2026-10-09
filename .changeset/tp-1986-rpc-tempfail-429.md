---
"@titan-design/rpc-protocol": minor
"@titan-design/daemon": patch
---

Add `EXIT.TEMPFAIL` (75) and `RPC_STATUS.TOO_MANY_REQUESTS`. `rpcFailureStatus` maps a command that refuses a caller over its limit with `TEMPFAIL` to 429, so `POST /rpc/:name` answers 429 for it instead of 500.
