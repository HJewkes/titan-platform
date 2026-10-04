---
"@titan-design/github": patch
---

Scrub token shapes from every `gh api` error and GraphQL error message, not only the exchange and check-run paths. The JWT shape no longer matches dotted names such as `eyJson.config.js`; a classic 40-hex token after a token keyword and a URL-encoded `ghs%5F` token are now redacted; a whole token at the end of stdout no longer eats the first word of stderr; and a token split by a trailing newline on stdout is cut from both streams.
