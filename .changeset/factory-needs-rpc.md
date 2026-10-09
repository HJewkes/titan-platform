---
"@titan-design/factory": minor
---

`titan-factory serve` registers `needs.list` and `needs.count`, so the console reads the owner's merged queue over loopback (`POST /rpc/needs.list`) or MCP (`needs__list`). `needs.list` returns `{ items, gaps }`, where `items` is the OwnerItem[] `titan-factory needs --json` prints, filtered by `kind`, `lens` and `initiative`; personal initiatives are left out unless `personal: true`. `needs.count` returns `total`, `byKind` and `byLens` under the same filters. An agent-chat `approval_request` or `endorse_request` row now stays a one-way approve item even when its meta names another item kind.
