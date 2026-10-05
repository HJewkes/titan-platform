---
"@titan-design/github": patch
---

`redactStreams` redacts an exact secret whose bytes straddle the stdout/stderr seam. The early return that keeps each stream on its own looked only at token-shaped spans, so a secret split across the streams reached neither half whole and showed in both.
