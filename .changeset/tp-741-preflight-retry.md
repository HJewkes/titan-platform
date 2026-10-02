---
"@titan-design/factory": patch
---

The release preflight retries a registry.npmjs.org read that fails with a 5xx or a network error, waiting 2, 4 and 8 seconds. If every attempt fails, the step fails and stores no blocked result, so the next sweep restarts the run and reads the registry again. A head blocked only by packages that npm answered 404 for still gates on the owner. Each sweep now re-reads npm for those packages, and once a hand publish lands it cancels that gate so a fresh run reads the release again.
