---
"@titan-design/explainer": minor
---

`eval cold` scores reader gaps from the spoken words only (TP-3807). Both cold prompts now show each beat's spoken words and end, never the on-screen labels, since the reader-gap labels come from readers who had the narration only. Spoken terms are asked "what does X mean here?" in a call of their own per chapter, under the new rubric `l1-cold-spoken.md`, which does not count a sentence that only uses the word as a definition; that call has its own canary. A term inside a longer new label ("I2 verdict at head") is now asked on its own. `ColdChapter.canary` becomes `canaries`, one a call. `playbackTranscript` is renamed `spokenTranscript`. The new `readerGapScores` scores each labelled reader-gap group at its items' first questions, and `eval cold --labels <file>` prints it per run. The eval_version changes.
