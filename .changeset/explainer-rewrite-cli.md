---
"@titan-design/explainer": minor
---

Add `explainer rewrite <script> --judge <cfg> --out <file> [--format spike] [--rounds 1|2] [--speech-vet] [--report <file>]` and export `runRewriteCli`. It runs `rewriteScript`, writes the script/v1 result and its report, and exits 0 when every target row passes, 1 when one is still red, 2 on usage or parse errors. `--speech-vet` vets each 26-32 word sentence of the input and of every reply with local Kokoro and Whisper. `guardBeat` no longer counts the words of a number moved into an appended label as dropped content terms, so moving "5000 rows" to a label is accepted. The guard compares numbers in one numeric form, whether spelled or in digits ("twenty-eight" matches a "28 slots" label, "a hundred and ninety" matches "190"), and a cue on a number moved into a label lands on the label's noun when the line still speaks it. The planner guide now says to run `explainer rewrite` after drafting.
