---
"@titan-design/daemon": patch
---

Use one recursive `fs.watch` on macOS and Windows instead of a handle per directory.

Per-directory watching cost one FSEvents handle per directory, and each close is a
semaphore round-trip serialized on the main thread: measured at 7.9ms across 1,593
directories, which is 12.6s of a daemon's SIGTERM handler. Linux keeps the hand-rolled
crawl, where recursive `fs.watch` is version-dependent. `isWatching` and `whenWatching`
keep their meaning — "writes here reach the change feed" — which under a recursive root
watch is any existing path beneath it.
