---
"@titan-design/factory": patch
---

`shepherd status --deploy` reads how far origin/main is past serve's running build from git, so merges that never asked for a deploy count as behind, `behindMinutes` runs from the oldest of them, and an unreadable git or an unknown running sha alarms instead of reading behind 0.
