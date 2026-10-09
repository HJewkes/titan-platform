---
"@titan-design/factory": minor
---

Add an optional `remoteFactory` URL to the factory config. While it is set, `serve`, `resume`, `land`, `gate resolve` and `shepherd register|hold|release|resync` exit 2 before probing a serve or opening any database, and every other verb refuses to open the local database; the message names the remote and says this host's database is frozen. A misspelt `remoteFactory` key fails the config load.
