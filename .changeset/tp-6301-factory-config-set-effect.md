---
"@titan-design/factory": minor
---

Add the factory-config-set owner op effect (TP-6301). A console tap sets one live editable factory config row only while the file still holds the op's `expectFrom` (a hand edit answers `moved`), refuses a path or value the editable rows reject and a result the config schema rejects, then keeps a `config.json.bak-console-<tag>` backup, replaces the file through a temp file, fsync and rename, appends `config.revisions.jsonl`, reloads the config ref and answers with the value serve now reads.
