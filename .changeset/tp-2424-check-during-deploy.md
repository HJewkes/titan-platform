---
"@titan-design/factory": patch
---

`titan-factory service check` no longer reports `stale build` while a live process holds the deploy lock: it exits 0, names the deployer pid and target build, and still reports GitHub down, a stalled deploy and the later causes. A dead or absent lock holder still reads `stale build`.
