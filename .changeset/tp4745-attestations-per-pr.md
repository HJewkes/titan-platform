---
"@titan-design/factory": patch
---

Attestation rows move from the single `src/registry/attestations.json` to one file per PR, `src/registry/attestations/<pr>.json`, so two open PRs that each add rows no longer conflict. Shepherd's `readClaims` reads the directory as the union at the base and at the head, with the same strict row schema; a listing or file that cannot be read, a malformed file, or a stray file name reads as unread. A ref from before the directory is read from its legacy file.
