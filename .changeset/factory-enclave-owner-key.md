---
"@titan-design/factory": minor
---

The owner-presence helper gains `keygen`, `pubkey` and `sign` for a Secure Enclave P-256 key that needs Touch ID or the login password for every signature. `keygen [--tag <tag>] [--replace]` writes the key's opaque enclave blob with mode 0600 to `~/Library/Application Support/titan-factory/<tag>.se` (tag `owner-key` by default) and refuses to overwrite it without `--replace`. `pubkey [--id]` prints the SPKI PEM, or a 16-hex key id from sha256 over the SPKI DER. `sign [--] <reason>` signs the bytes on stdin and prints a base64url DER ECDSA P-256 SHA-256 signature. With one argument the helper still shows the presence dialog and prints a proof id. `signStatement(bytes, reason)` runs `sign` through the same helper path checks as `confirmOwner` and returns the signature, or undefined. Rerun `pnpm factory:install`, and the root `install` if you use one, to rebuild the helper.
