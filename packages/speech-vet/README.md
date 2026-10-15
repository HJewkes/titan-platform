# @titan-design/speech-vet

Pronunciation vetting for narration: override markup, heteronym reading checks, the
`lexicon.v1` schema with respelling, initialism spelling, and phone-level verdicts on what a
voice actually said. Pure TypeScript; it loads no model, and G2P is injected.

Tier 2 of the titan-platform DAG. May import only packages in the same tier or
below; the `package-layers` rule in `.codewatch/check.json` enforces this in CI.

## API

- `plainText(spoken)` and `g2pText(spoken)`: the caption text with all markup removed, and
  the text a misaki G2P is given, with overrides kept and declarations reduced to the word.
- `checkReadings(spoken, tokens, table?)`: one `ReadingFinding` per heteronym occurrence in
  the G2P tokens of `g2pText(spoken)`, with status `ok`, `fail`, `forced` or `warn`.
- `englishHeteronyms`: the 19-word table from `src/heteronyms/en.json`, in misaki notation.
- `LexiconSchema`, `loadLexicon(json)`, `respellingsOf(lexicon)`: `lexicon.v1`, which also
  upgrades a flat `{ term: respelling }` map and an unversioned `{ entries }` list.
- `respeller(map)` and `generateCandidates(word, limit?)`: whole-word respelling and
  heuristic respelling candidates.
- `spellInitialisms(text, { spelled? })` and `isInitialism(token)`: dotted letters for
  all-caps initialisms, with a caller-supplied list for a domain's vowel-bearing ones.
- `normalize(text, steps?)`: runs `NormalizeStep`s in order. `DEFAULT_NORMALIZE_STEPS` is
  rates (`/week` to ` per week`), initialisms, clock times, then `NUMBER_STEPS` (ages,
  ordinals, currency with k/m/bn magnitudes, decimals, cardinals of 100 or more), then
  whitespace. Filter the list by `step.name` or splice in a product's own steps; `rateStep(units)`
  and `initialismStep(opts)` take a domain's extra units and initialisms.
- `numberToWords(n)`, `numberToOrdinal(n)`, `spellDigits(digits)`: the number words the steps use.

## Phone check

A port of the audiobook backend's `validation/phonemes.py`, at verdict parity with it. Expected
phones come from a `PhoneG2p`, `(text, voice) => string`, that returns espeak-ng's raw
`--ipa=3` output; `voice` defaults to `en-us`. Actual phones come from a phone recognizer such
as speech-stt's `wav2vec2Recognizer`.

- `chunkWordVerdicts(text, actualPhones, { g2p, targets, unusual?, voice? })`: per target
  word, `xtts` (the audio mispronounces it), `whisper` (the audio is fine) or `inconclusive`
  (the alignment degenerated), with the distance and both phone strings.
- `detectHallucinations(text, actualPhones, { g2p })`: runs of audio phones with no source text.
- `detectTailArtifact(text, actualPhones, { g2p })`: phones after the last expected phone, or `null`.
- `recognizePhones(recognizer, audio)`: the recognizer's raw decode, cleaned.
- `cleanIpa`, `phonemeDistance`, `phoneMatchDistance`, `admissiblePhones`, `g2pSentence`,
  `WEAK_FORMS` and the thresholds the verdicts use.

## Conformance fixtures

`conformance/normalize.json` ships in the package. Each case names the steps run, the input,
the expected output, and the audiobook `TextNormalizer` method that must agree, so a Python
port can pin a release and check itself against the same cases.
