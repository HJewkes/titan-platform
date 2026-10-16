---
"@titan-design/factory": patch
---

Add `ownerKeyId`, which reads the owner's Secure Enclave key id through the checked owner-presence helper (`pubkey --id`) so the Mac client can refuse before prompting when its key is not installed on the remote factory.
