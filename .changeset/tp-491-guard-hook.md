---
"@titan-design/tool-guard": minor
---

Add `decide`, `observeActor`, the deny log format, `handle` and the `titan-tool-guard` bin with `hook`, `print-settings` and `report`. The hook denies a classified merge, release, credential read, permission-config edit or private egress through the PreToolUse deny answer, never throws and always exits 0. `print-settings` prints the settings entry and writes nothing.
