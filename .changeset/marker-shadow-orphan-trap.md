---
"@titan-design/factory": patch
---

The marker shadow names each marker's call site as `<workflow>/<declared step id>`, logs every call an entry visits, and when a drive settles sends each valid marker the run left at a skipped call site to the sink once as a fail-closed `call-site-orphan`. After an orphan the shadow reports no would-fast-forward for that run. The shadow stays off by default and changes nothing the run records.
