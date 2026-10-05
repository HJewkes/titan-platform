---
"@titan-design/github": patch
---

`redactStreams` deduplicates the secret list before its exact-secret scans, so repeated secrets no longer multiply the spans, and its doc names the whitespace-secret-cut-at-the-seam limit.
