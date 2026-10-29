---
"@titan-design/speech-g2p": patch
---

`misakiEnglish()` grows the vendored gold and silver dictionaries once per process and shares them across instances; caller `words` still apply per instance.
