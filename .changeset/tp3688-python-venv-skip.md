---
"@titan-design/code-parser": patch
"@titan-design/code-graph": patch
---

Skip Python virtualenvs and tool caches in the source walk (TP-3688). `.venv`, `venv`, `__pycache__`,
`.pytest_cache` and `.tox` are now excluded directories, and `walkSourceFiles` also skips any
directory holding a `pyvenv.cfg`, so a virtualenv under any name no longer floods the graph.
