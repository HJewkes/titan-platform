---
"@titan-design/speech-g2p": patch
---

Add the golden fixtures for `speech-g2p` (TP-3027 S2): a 418-unit corpus of our own text, misaki 0.9.4 token and phoneme goldens with a recorded espeak fallback map, spaCy tokenizer goldens, num2words goldens, and the dumped spaCy English tokenizer data. Tests only read them.
