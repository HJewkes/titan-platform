---
"@titan-design/tool-guard": patch
---

The walk reads a marked `((` as an arithmetic command: its words are no longer reported as commands, while substitutions inside it and spans that read as a command (`((git push))`) are still walked.
