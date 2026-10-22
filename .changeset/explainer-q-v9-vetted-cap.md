---
"@titan-design/explainer": minor
---

Q-V9 lets a narration sentence of 26 to 32 words pass when a speech-vet verdict reports it clean to speak: `voiceCheckWith(entities, { speechClean })`. Without a verdict the cap stays 25, and 33 words always fails (TP-3814).
