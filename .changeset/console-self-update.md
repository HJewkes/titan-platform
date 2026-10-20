---
"titan-console": minor
---

The served console updates itself. `titan-console self-update`, run every 10 minutes by the shipped `titan-console-update.timer`, fetches origin/main and does nothing unless a commit since the served sha changes the console or a workspace package pnpm says it bundles. Otherwise it builds the new sha in its own release dir, starts it on a spare port and checks `/health` and `/`, swaps the `current` symlink, restarts `titan-console.service` and checks the served build sha. Any failure keeps or puts back the old build, records the outcome, holds that sha until main moves, and files an owner-queue item in the console's inbox spool. The build now stamps `dist/build-info.json`; `/health` carries it as `build`, the new `console.build` read returns it, and the footer shows the short sha and build time.
