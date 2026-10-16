---
"@titan-design/speech-vet": minor
---

speech-vet: add `espeakCliG2p`, a `PhoneG2p` that runs `espeak-ng -q --ipa=3 -v <voice> <text>` through an injectable runner with a 10 second timeout, returning "" and calling `onError` on failure as the audiobook backend does. `espeakVersion()` reports the installed version. espeak-ng is a GPL binary the caller installs (apt or brew); it is called as a process and not bundled.
