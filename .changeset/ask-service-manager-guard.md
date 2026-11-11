---
"@titan-design/factory": patch
---

The deploy guard `serviceRunsFromCheckout` now asks the service manager for the loaded job (`systemctl --user show --property=LoadState,ExecStart` on Linux, `launchctl print` on macOS) instead of reading the unit or plist text. It is true only when exactly one loaded command runs the checkout bin as its script argument, and false whenever the answer is missing, ambiguous or unloaded. A unit or plist on disk that is not loaded now makes deploy prepare-only.
