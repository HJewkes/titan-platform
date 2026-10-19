---
"titan-console": patch
---

`config.surfaces` no longer reads a `README.md` or a dotfile in the autonomy `seats/` directory as a seat. The surface specs move from `catalog.ts` to a sibling `specs.ts`, with no change in behaviour.
