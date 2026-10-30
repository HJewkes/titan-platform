---
"@titan-design/explainer": patch
---

The custom-layer build check now holds a layer to every kind qa's gate can hold, not only low-contrast and off-frame (TP-4606). It reads render-qa's own list, `ERROR_KINDS`, at qa's samples with qa's `classify` and `addLateFill`, so a kind qa gates can no longer pass the build unchecked. Content overflow, overlaps, orphaned wraps and late-fill now join the one rebuild, each with a fix. The custom-layer doctrine warns against fixed-height panels around text that can wrap. resolve moves to `p5c2s2f2s2d11`.
