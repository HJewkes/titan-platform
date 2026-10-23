# review-addendum-v5 spike fixtures

The review addendum explainer, 23 beats: the second frozen script of the A2 goldens (`../goldens/`). Do not
edit it to make a test pass: re-freeze from the source below and record the new hashes.

## `script.json`

The Python-emitted addendum script, revision 2 (`review-addendum-v5/r2/script.json` in the A1 snapshot,
sha256 `a3d5ae8f833f023e88e91dd73b77f0e9fc7fb5df3944dfe57b3c49f9f7edc96e`), copied byte for byte. It names no
internal seat or agent. Its spoken lines keep their pronunciation markup (`[word](/phonemes/)`).

## `durations.json`

A durations-only extract of motion-spike `examples/samples/review-addendum-v5.words.json` at commit `209c91b`
(branch `video/rx-addendum-r2`, sha256 `32abdd92d4543edc9d9ad7e39c3e8671c2931b7622066c6e9d6784c65f9a4690`):
`{id, durationS}` for all 23 beats, the input the `sweep_moments` golden was computed from.
