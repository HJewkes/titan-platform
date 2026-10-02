---
"@titan-design/factory": minor
---

Shepherd redeploys the factory after a green main CI on its own repo: step `sh-redeploy:<merge sha>` spawns `titan-factory service deploy --expect <merge sha>` detached, logging to the state dir, and returns at once. Other repos and a red or unread main skip it; a replay after the restart it caused spawns nothing.
