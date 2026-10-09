---
"@titan-design/factory": minor
---

Add `POST /gates/resolve-proof` on `serve`. It applies an owner-signed proof through `applyProof` and returns each item's outcome. The route is mounted through the daemon's `mountRoutes`, behind its existing guards, and is neither an MCP tool nor an RPC command; bodies over 512 KiB get 413. Owner public keys load once at start from the fixed root-owned directory `/etc/titan-factory/owner-keys/*.pem`, with every path component lstat-checked (uid 0, no group or other write, no symlink); a failed check or no key answers 503 `owner keys not installed`. `/health` reports `ownerKeys` (the loaded key ids, or the refusal), and `factory.gates` returns `aud`, the hostname a proof must name.
