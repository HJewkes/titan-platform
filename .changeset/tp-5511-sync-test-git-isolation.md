---
"@titan-design/factory": patch
---

The autoresearch sync test's temporary repositories now run git with the machine's global and system config and hooks switched off, so a host-wide pre-push hook no longer fails its pushes to the temporary origin. Test only; no production code changes.
