---
"@titan-design/github": patch
---

The token exchange and `createCheckRun` error paths now scrub anything shaped like a GitHub token or a JWT, including a token split across stdout and stderr and one quoted by a rejecting `appToken`, instead of relying on a closed `"token":"x"` pair.
