---
"@titan-design/explainer": patch
---

A later run on a base run (`explainer run --from <stage> --base <run>`) that names no `--profile` now keeps the base run's video type, as it already kept the base's gather. Before, such a replay voiced every beat in the default voice at the default rate, so a fresh resolve of a stored daily ran about 12 % longer than its base and its still stretches failed qa's static-window and picture-change gates. A `--profile` on the later run still wins. No stage version moves: tts already keys on the voice it speaks in.
