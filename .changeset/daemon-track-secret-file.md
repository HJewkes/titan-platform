---
"@titan-design/daemon": minor
---

Add `trackSecretFile(file, parse)`: the tracked, stat-checked secret file reader (symlink, not-regular, owner, mode refusals; re-read on change) for any secret shape. The caller injects the path and the parser; a parser's error text is never copied into the refusal. `trackTokenFile` is now `trackSecretFile(file, parseBase64Secret)`. Also exports `SecretRejection`, `SecretParser` and `parseBase64Secret`.
