---
"@titan-design/explainer": patch
---

Qa reports a photosensitive flash check (WCAG 2.3.1). The stage decodes the MP4 at 160x90 and counts general flashes (opposing relative-luminance swings of 0.10 or more, darker state below 0.80) and red flashes (swings to or from a saturated red) over the title-safe area, per trailing second, covering at least the small-area threshold. More than three a second fails the `photosensitive-flash` check, reported until `FLASH_GATE` in `gate-profile.ts` is flipped. qa.json gains `flash`; the qa stage version moves to x10k.
