---
"@titan-design/speech-g2p": minor
---

`misakiEnglish({ words })` takes misaki phonemes for words the shipped lexicon misreads or lacks. They match case-insensitively, are read ahead of golds and special cases, and fold into `version`; with no `words` (or an empty map) the version is unchanged.
