---
"@titan-design/tool-guard": patch
---

A shell that runs a file the guard cannot read in full now denies: a FIFO, a directory, a missing or unreadable file, or a script longer than the 64 KiB the guard reads (`bash < ./fifo`, `bash /dev/stdin < ./unreadable`, `bash ./big.sh`, `bash < ./big.sh`). `nodeContext`'s `readScript` throws `UnreadableScriptError` for such a file, reading one byte past the cap to tell a cut file from one of exactly 64 KiB; an interpreter's script keeps the mention rule over what was read (TP-3257).
