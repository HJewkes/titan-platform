---
"titan-console": patch
---

Make `inbox.list` fast and small: the factory's needs.list and Shepherd's finished runs are kept for 15 s and served for up to 5 min while one refresh runs behind them (an `inbox.act` drops them), the finished runs are read beside the queue instead of after it, rows leave out the `context`, `anchors`, `pins` and recommendation rationale and cite the page never renders, and the default view only counts the planning items (`planningCount`). The inbox page reads them with `{ planning: true }` when the Planning section opens.
