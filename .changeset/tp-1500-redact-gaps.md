---
"@titan-design/github": patch
---

Close the remaining token-redaction gaps: a 40-hex token after `GH_TOKEN=`, `"access_token":` or as URL userinfo, a JWT right after an underscore, a split across stdout and stderr past any whitespace or a trailing keyword, and the Link next URL in a refused-page error. A dotted file name that only opens like a JWT is no longer redacted.
