---
"@titan-design/explainer": minor
---

Voice each beat at its beat type's speech band (TP-2670). The tts stage now reads the `resolved` artifact for each beat's band and calibrates Kokoro's speed (speech-tts `calibrateSpeed`) to that band's words a minute times the profile's voice rate, then trues the beat from the calibrated take. The bands (story 195, concept 175, code 160, takeaways 180 wpm; caps 3.2 / 2.8 / 2.3 / 2.8 words/s, held 1.5) move into `doctrine/speech-bands.yaml`, which the word budget reads too. `voice.json` (`explainer.voice/v2`) records each beat's band, target rate, speed and measured rate, and the take cache keys on the target rate.
