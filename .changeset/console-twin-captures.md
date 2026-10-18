---
"titan-console": patch
---

Add `pnpm --filter titan-console capture`, deterministic twin captures of every console route. It renders the built page from disk with no daemon, from fixtures typed against `ConsoleCommands`, and shoots each route twice at phone and desktop widths. It fails on any byte difference between the two shots, and writes the frames and a `manifest.json` to `dist/twin` for visual review packets. `work.*` reads take an optional `now` clock for their `fetchedAt`.
