---
"@titan-design/agent-dispatch": patch
---

`DispatchError`, `BrokerUnavailableError` and `DispatchTimeoutError` carry a fixed `name`, so a caller can record which kind of failure it was without its message.
