---
"@titan-design/code-graph": minor
---

Python imports the tree does not hold no longer become `npm:` externals (TP-307). A standard-library import is now `python:<module>` (`import os.path` gives `python:os`), and any other absolute import is `pypi:<top-level package>` (`import requests.adapters` gives `pypi:requests`). A relative import that resolves to no file in the tree (`from ..constants import x`) is dropped instead of becoming `npm:..constants`. Rules or views that matched Python externals by their `npm:` id must switch to the new prefixes. `INDEX_VERSION` moves to 0.35.0, so stored indexes with the old ids are not reused.
