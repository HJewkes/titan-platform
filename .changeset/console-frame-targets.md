---
"titan-console": minor
---

Hit-test pins on PNG frames (TP-3773 S5b). A frames@1 record may name an element map as `targets: { file, sha256 }`; the new read `rounds.frameTargets {id, key}` returns its boxes after the same no-symlink, capped (256 KiB), sha256-checked read as a PNG. `rounds.frames` marks such frames `targets: true`, and in pin mode a pin records the smallest box under it as its `target`. A round without `targets` still pins coordinates only.
