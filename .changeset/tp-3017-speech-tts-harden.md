---
"@titan-design/speech-tts": patch
---

commandTts hardening (TP-3017): a named WAV with more than one hard link is refused, a JSON `wav` must be a bare filename, a failed scratch-directory cleanup is logged instead of replacing the result, and an already-aborted signal rejects without spawning the command.
