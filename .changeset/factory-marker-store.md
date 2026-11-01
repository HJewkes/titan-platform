---
"@titan-design/factory": patch
---

The marker table gains its store: `writeMarker`, `currentMarker`, `markerHistory` and `readMarkerValues`, with read values and outputs kept by content address. A value of 256 KB or less sits inline; a larger one goes to a file under `<db dir>/marker-blobs`, named by its digest and written by temp file and rename. Every write passes the capability guard, and a store with no guard refuses writes. Nothing calls it yet.
