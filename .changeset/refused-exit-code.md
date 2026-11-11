---
"@titan-design/factory": patch
---

Name the refusal exit code: `EXIT.REFUSED` is 65. `shepherd register` on a denied repo or a charter hard stop exits 65, a usage error still exits 2, and which registrations are refused is unchanged. CLI tests cover both.
