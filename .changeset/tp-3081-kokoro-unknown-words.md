---
"@titan-design/speech-tts": minor
---

Add `unknownWords: "warn" | "fail"` to `kokoroProvider` and to Kokoro profile entries. With `"fail"`, synthesis rejects before the model loads with the new `TtsUnknownWordsError` (code `unknown-words`), whose `words` lists every word with no phonemes and its token index. `"warn"` stays the default: such a word keeps its zero-width timing and a warning.
