# Vendored data

`wav2vec2-lv60-espeak-vocab.json` is `vocab.json` copied byte for byte from
`facebook/wav2vec2-lv-60-espeak-cv-ft` at commit `ae45363bf3413b374fecd9dc8bc1df0e24c3b7f4`. The ONNX export
`wav2vec2Recognizer` loads, `onnx-community/wav2vec2-lv-60-espeak-cv-ft-ONNX` (pinned as `WAV2VEC2_REVISION`,
`c69750f5043e5e1f8a71ab95dd3b98338c280c92`), ships no tokenizer, so the vocab travels with the package and no
tokenizer is ever fetched. Do not edit it; `src/wav2vec2.test.ts` checks token ids against it.

| File | Bytes | sha256 |
|---|---|---|
| `wav2vec2-lv60-espeak-vocab.json` | 4637 | `d732ab2456c0c017930001dc9af0b41b3b93d25b2eb9740bf9d925508d7d87d0` |

392 tokens. `<pad>` (0) is the CTC blank; `<s>` (1), `</s>` (2) and `<unk>` (3) are dropped by the decode.

Licence: Apache-2.0, for both the upstream model and the ONNX export (their Hugging Face model cards). See
`../NOTICE`.
