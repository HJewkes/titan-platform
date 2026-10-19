---
"titan-console": patch
---

`inbox.list` gains `derived`: machine-raised rows for Shepherd stalls past 15 minutes in phase, runs that failed in the last day, and agents blocked for more than 15 minutes. Each row carries its evidence (what was observed, the source, and since when) and the threshold it crossed, and links to the run's timeline or the agent page. Derived rows have no action and sit beside `items`, so `inbox.act` never acts on them. A row without evidence is refused at construction. The inbox page shows them under "Raised by the console" with no button.
