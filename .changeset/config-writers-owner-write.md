---
"titan-console": patch
---

Add a structure test that walks the served registry: every `config.*` command is owner-write unless its verb only reads, and no read or deposit command changes a config file.
