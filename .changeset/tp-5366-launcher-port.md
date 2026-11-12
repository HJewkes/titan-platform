---
"@titan-design/factory": patch
---

The inherited-socket serve test now has its python launcher report the port it bound, and checks serve's logged port against that instead of trusting serve's own log. Test only; no production code changes.
