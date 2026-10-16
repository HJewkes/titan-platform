---
"@titan-design/speech-g2p": patch
---

Add the misaki pipeline port (`MisakiEngine`: preprocess with `[text](feature)` overrides, char-offset feature alignment, fold_left, subtokenize, retokenize, the right-to-left lexicon and number pass, resolve_tokens, merge_tokens). With spaCy's recorded tokens and tags it matches misaki 0.9.4 on all 7,502 golden tokens, stress included. Internal; not exported from the package entry yet.
