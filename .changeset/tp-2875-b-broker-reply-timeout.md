---
"@titan-design/agent-dispatch": patch
---

A CLI exit whose stderr is the line `broker did not answer <frame>_result` now rejects with `DispatchTimeoutError` instead of a plain `DispatchError`, since the frame may have landed.
