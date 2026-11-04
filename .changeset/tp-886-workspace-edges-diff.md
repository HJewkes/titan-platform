---
"@titan-design/active-work": patch
---

The workspace index writes its derived edges by diff: a pass inserts only new edges and deletes only vanished ones, so a refresh over an unchanged workspace writes no edge rows and no longer grows `edge_id`.
