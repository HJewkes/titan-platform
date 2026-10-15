---
"@titan-design/speech-g2p": patch
---

Add `spacyTokenizer`, a port of spaCy 3.8's English tokenizer (`Tokenizer.explain` plus its whitespace-token rule) over the dumped `en_core_web_sm` data, with the Python patterns translated to JS regexes at load. Internal; not exported from the package entry yet.
