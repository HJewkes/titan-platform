# @titan-design/speech-vet

## 0.1.1

### Patch Changes

- 9569f7b: Fold a final `e` and `y` in the content-term stemmer, and stem four-letter words, so "raises"/"raise", "carries"/"carry" and "sets"/"set" read as one term in the rewrite guard.
- Updated dependencies [938ede4]
- Updated dependencies [f7b9e60]
- Updated dependencies [9b42150]
- Updated dependencies [10c117f]
- Updated dependencies [8bd93fc]
  - @titan-design/speech-g2p@0.2.0
  - @titan-design/speech-stt@0.1.1
  - @titan-design/speech-tts@0.1.1

## 0.1.0

### Minor Changes

- 4d3f8a8: Add `normalize(text, steps?)` with composable `NormalizeStep`s that expand numbers, ordinals, decimals, currency, clock times and per-unit rates, plus `conformance/normalize.json` for ports to check against.
- 29d00e7: `checkReadings` reports a `[w](=reading)` declaration that no token matches as a `fail` finding instead of dropping it, and reads a possessive token such as `lead's` as the declared `lead` so it no longer skews later ordinals. `loadLexicon` throws when two terms differ only in case, naming both.
- 8b35cfc: Add speech-vet part 1, a TypeScript port of the narration text checks: `plainText` and `g2pText` for `[word](/phonemes/)` overrides and `[word](=reading)` declarations, `checkReadings` against the 19-word misaki heteronym table in `heteronyms/en.json`, the zod `lexicon.v1` schema with `loadLexicon` (it upgrades a flat respelling map and an unversioned entries list), `respeller` and `generateCandidates`, and `spellInitialisms`. The vowel-bearing initialism list holds general English only; a product passes its own domain list through `spelled`.
- d3f133d: speech-vet: add the phone check, a port of the audiobook backend's phoneme validation at verdict parity. `chunkWordVerdicts` gives each target word an `xtts`, `whisper` or `inconclusive` verdict, `detectHallucinations` finds babble runs and `detectTailArtifact` finds stray phones after the last word. G2P is injected as `PhoneG2p` (espeak-ng's raw `--ipa=3` output, voice `en-us` by default), and `recognizePhones` cleans a recognizer's raw decode. speech-vet now depends on speech-stt.

  speech-stt: export `roundHalfEven(x, digits)`, Python's `round`, half to even on the exact binary value.

- db712f5: speech-vet: add `espeakCliG2p`, a `PhoneG2p` that runs `espeak-ng -q --ipa=3 -v <voice> <text>` through an injectable runner with a 10 second timeout, returning "" and calling `onError` on failure as the audiobook backend does. `espeakVersion()` reports the installed version. espeak-ng is a GPL binary the caller installs (apt or brew); it is called as a process and not bundled.
- 375ef5d: Add `detectDefects` and `confirmDefects`, a port of the audiobook defect check at output parity, with `defectOptionsFor(stt)` gating the recogniser-confidence signal on the provider's `tokenLogprobs` capability (off by default). Also export `isUnusualWord`, `tokenizeWords`, `metaphone` and `phoneticDistance`.
- d3fccc4: Add `synthesizeVerified` (re-roll babbled takes), `keepTake`, `regressions` and `bestTailTake` (pick the better take and catch tail regressions), ported from the audiobook backend (TP-3037).
- daf68da: speech-vet: add `checkHeardReadings`, the post-synthesis reading check. It aligns a phone recognizer's output to the IPA of the tokens the voice was given and reports, per declared `[word](=reading)` heteronym, the reading heard and `ok`, `fail` or `inconclusive`. Expected phones come from an injected misaki-to-IPA map (speech-g2p's `misakiToIpa` fits), so it needs no espeak-ng. `readingIpa` and `expandReading` expose each reading's IPA.
- d5adf04: TP-3039 S4: speech-vet `vet()` runs the vet cycle over injected providers (precheck, token passthrough to a misaki voice, every retake checked in full, best take kept, futility stop) and now depends on `@titan-design/speech-tts`. Internal until S5 exports it.
- d3d2bdb: TP-3039 S5: speech-vet exports `vet()`, `applyLexicon` and the `Vet*` types, documents the vet cycle and its working defaults, and ships `conformance/take-selection.json` so a port can check its take-selection margin against the same cases.
- d609dcb: TP-3040 S3: speech-vet exports the pronounceable-text rewriter. `rewriteLine` replaces only the sentence holding a `needs-rewrite` span: a pinned sentence resolves from `RewritePins` with no candidate asked, a pinned rewrite is refused, and each candidate from the `symbolRules` rule tier or an injected `CandidateSource` passes `guardRewrite` and must re-vet `accepted` before it is pinned. Also exports `guardRewrite`, `contentTerms`, `RewritePins`, `RewritePinsSchema`, `pinKey`, `applyPins`, `UnpinnedRewriteError` and `SYMBOL_WORDS`.
- 73799b3: Add `misakiIpaG2p`, a `PhoneG2p` built on speech-g2p's `misakiEnglish().tokens()` and `misakiToIpa`, so expected phones need no espeak-ng binary (TP-3066). speech-vet now depends on `@titan-design/speech-g2p`, which must be published before speech-vet.

### Patch Changes

- 255af30: Ship the panphon 0.22.2 phone feature table (`data/`, MIT licence included) and an internal loader, the base for a feature-weighted phone distance. No public API change.
- 29ed958: `whisperStt` now declares `capabilities.tokenLogprobs: true`. A logits processor records each decode step's token
  log-prob, so words carry `probability` and each 30 s decode window is one segment with `avgLogprob` and
  `compressionRatio`, with faster-whisper's semantics. `whisperStt({ tokenLogprobs: false })` keeps the old shape: no
  `probability` and empty `segments`. `defectOptionsFor(whisperStt())` therefore turns speech-vet's signal A on.
- Updated dependencies [078d781]
- Updated dependencies [3a3c321]
- Updated dependencies [1b17331]
- Updated dependencies [41e22b4]
- Updated dependencies [fd698f1]
- Updated dependencies [0dd4dac]
- Updated dependencies [23b6690]
- Updated dependencies [d88f9b1]
- Updated dependencies [e84cd4a]
- Updated dependencies [f005405]
- Updated dependencies [2ba145d]
- Updated dependencies [f0016dd]
- Updated dependencies [16a909c]
- Updated dependencies [fd70652]
- Updated dependencies [37c0274]
- Updated dependencies [fc60b0a]
- Updated dependencies [324c4fd]
- Updated dependencies [4c09b9a]
- Updated dependencies [110547b]
- Updated dependencies [a8eb644]
- Updated dependencies [d3f133d]
- Updated dependencies [e18ac5e]
- Updated dependencies [67278c2]
- Updated dependencies [cca14b1]
- Updated dependencies [57c76dd]
- Updated dependencies [fca61b7]
- Updated dependencies [bd52653]
- Updated dependencies [063cd08]
- Updated dependencies [29ed958]
- Updated dependencies [a6f6ee5]
  - @titan-design/speech-g2p@0.1.0
  - @titan-design/speech-stt@0.1.0
  - @titan-design/speech-tts@0.1.0
