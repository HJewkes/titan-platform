---
"@titan-design/react-app": minor
---

`RpcProvider` and `createQueryStore` take a `gcMs` option. An unwatched query keeps its result for that long, so a page revisited inside the window shows the kept data at once while a refetch runs behind it. The default of 0 keeps today's drop-a-tick-after-unmount behavior.
