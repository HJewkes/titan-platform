---
"titan-console": patch
---

The console build no longer fails when git is unavailable (no `.git`, or a checkout another user owns). `stamp-build` warns, removes any earlier `dist/build-info.json` and exits 0, so `/health` and the footer report an unstamped build.
