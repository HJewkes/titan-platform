---
"@titan-design/explainer": patch
---

The qa speech-rate report now leaves out a beat with no word timings instead of counting it as 0 words, so a words.json with no word arrays gives `overallWpm: null` and the summary "speech rate: not measured (no beat has word timings)" rather than "0 wpm OUTSIDE". Tests also pin `speechRate` as the first qa.json key after `schema` and the speech-rate line as the first stage note.
