---
"@titan-design/explainer": patch
---

The chunked script path sends its shared sections as one cached system prompt and gives each chapter call only the facts placed in that chapter, so later chapter calls read the prefix from the prompt cache. Stage notes and the run report show cache tokens read and written.
