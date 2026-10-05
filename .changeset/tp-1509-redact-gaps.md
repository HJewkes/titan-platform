---
"@titan-design/github": patch
---

Close three token redaction gaps. A JWT is now found from the dot behind its header, so a long run of JWT-shaped words such as `-eyJaaa-eyJaaa...` is scanned in linear time. `redactStreams` now cuts URL userinfo that only stderr completes (`https://HEX` then `:x-oauth-basic@h`, or `https://u:HEX` then `@h`). It also cuts the tail of a token split after its prefix even when stdout already ends in a whole token's worth, so the first word of stderr after a token that ends stdout is now cut with it.
