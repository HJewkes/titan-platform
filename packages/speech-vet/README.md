# @titan-design/speech-vet

Text-side pronunciation vetting for narration: override markup, heteronym reading checks,
the `lexicon.v1` schema with respelling, and initialism spelling. Pure TypeScript; it runs
no G2P and loads no model.

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
