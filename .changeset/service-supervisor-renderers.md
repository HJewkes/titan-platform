---
"@titan-design/service-supervisor": minor
"@titan-design/active-work": patch
---

Add `@titan-design/service-supervisor` with `renderSystemdUserService` and `renderLaunchAgentPlist`. active-work now renders its unit and plist through it; the unit's `NODE_ENV` line is now quoted like the other `Environment=` lines.
