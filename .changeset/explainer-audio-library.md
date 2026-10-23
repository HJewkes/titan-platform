---
"@titan-design/explainer": minor
---

Add the explainer audio library: `explainer audio import|gen|list`, an append-only `explainer.audio-ledger/v1`
ledger (`LedgerEntrySchema`, `importAudio`, `readLedger`) whose import normalises each file to 48 kHz mono WAV and
measures its loudness through ffmpeg, accepts only CC0-1.0, CC-BY-4.0 (with attribution) and generated-own, and
skips a file it already holds; plus a seeded procedural generator (`generateBed`, `generateSfx`) for a looping pad
bed and click, pop, whoosh, chime and riser SFX.
