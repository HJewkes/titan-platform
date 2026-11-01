---
"@titan-design/autoresearch": patch
"@titan-design/factory": patch
---

The re-measure after a sync step now requests the `seed` rung, which the factory accepts, instead of a rung named `sync`. Every eval request names the `head` its tree must be at, and the factory's eval port refuses a tree that sits at another sha.
