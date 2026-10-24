---
"@titan-design/explainer": minor
---

Add the composition page (TP-2991): one built Vite page under `src/composition/` that loads `timeline.json` from `?timeline=`, mounts react-ui 0.23's `MotionProvider` on a `seekClock` and resolves each beat's `kind` through a registry that parses its slots. The registry's `catalogue` beat renders `FileCard`, `SchemaCard` and `Annotate` live. `pnpm build:page` builds it into `dist/composition/`. A runtime-loaded timeline renders the same MP4 bytes as the fixture imported at build time, and an unknown kind fails the page.
