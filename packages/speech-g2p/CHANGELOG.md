# @titan-design/speech-g2p

## 0.2.0

### Minor Changes

- f7b9e60: `misakiEnglish({ words })` takes misaki phonemes for words the shipped lexicon misreads or lacks. They match case-insensitively, are read ahead of golds and special cases, and fold into `version`; with no `words` (or an empty map) the version is unchanged.

### Patch Changes

- 938ede4: Look up context-free punctuation tags in `punctTag` from one table, with no change to the tags it returns.
- 9b42150: Use the shared `isRecord`, `isObjectLike` and `errorCode` from `@titan-design/rpc-protocol/narrow` in place of local copies. Behaviour is unchanged.
- 8bd93fc: `misakiEnglish()` grows the vendored gold and silver dictionaries once per process and shares them across instances; caller `words` still apply per instance.
- Updated dependencies [5edd38d]
  - @titan-design/rpc-protocol@0.4.0

## 0.1.0

### Minor Changes

- 078d781: Add `misakiToIpa`, converting Misaki phoneme strings to IPA with optional stress stripping.
- e84cd4a: Scaffold `speech-g2p` (TP-3027 S1): token types and the vendored misaki 0.9.4 US lexicon with its loader. The engine follows.
- f0016dd: Add the public G2P: `misakiEnglish()` (tokens, phonemize, version) over the spaCy tokenizer port and the compromise tagger, and `ttsTokens()` for speech-tts. End-to-end parity with misaki 0.9.4 and spaCy is 99.324 % stress-strict on the CI golden and 99.42 % on the E4 corpus. The tagger now tags whitespace `_SP`, a plural possessive apostrophe `POS` and every currency symbol `$`, as spaCy does.

### Patch Changes

- fd698f1: Add the golden fixtures for `speech-g2p` (TP-3027 S2): a 418-unit corpus of our own text, misaki 0.9.4 token and phoneme goldens with a recorded espeak fallback map, spaCy tokenizer goldens, num2words goldens, and the dumped spaCy English tokenizer data. Tests only read them.
- 0dd4dac: Add the misaki lexicon lookup port (`Lexicon`: special cases, parent-tag fallback, NNP spelling, -s/-ed/-ing stems) and `applyStress`. Internal; not exported from the package entry yet.
- 23b6690: Add clean-room English number words and misaki's number reading (is_number, get_number, currency) to speech-g2p.
- d88f9b1: Add the misaki pipeline port (`MisakiEngine`: preprocess with `[text](feature)` overrides, char-offset feature alignment, fold_left, subtokenize, retokenize, the right-to-left lexicon and number pass, resolve_tokens, merge_tokens). With spaCy's recorded tokens and tags it matches misaki 0.9.4 on all 7,502 golden tokens, stress included. Internal; not exported from the package entry yet.
- f005405: Add the compromise-backed Penn tagger (`compromiseTagger`) with the modal and do look-back and the used-to rule.
- 2ba145d: Add `spacyTokenizer`, a port of spaCy 3.8's English tokenizer (`Tokenizer.explain` plus its whitespace-token rule) over the dumped `en_core_web_sm` data, with the Python patterns translated to JS regexes at load. Internal; not exported from the package entry yet.
