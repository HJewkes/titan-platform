---
---

Test-only: the login-probe exit-code test runs a committed fake codex instead of exec'ing a file it just wrote, which raced sibling threads' forks for ETXTBSY.
