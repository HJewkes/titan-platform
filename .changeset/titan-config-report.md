---
"@titan-design/titan": minor
---

Add `titan config report`: this host's config surfaces as file facts (present, mode, mtime, and size and sha256 for files that are not secret), never their values. `--to` deposits the report in the console's `config.report` over the LAN bearer.
