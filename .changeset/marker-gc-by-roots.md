---
"@titan-design/factory": patch
---

Add `collectMarkerBlobs`, marker blob GC by roots (TP-3105 S3). It keeps every blob referenced by a marker of an open item (superseded rows included), of an item whose landed row is inside the retention window, or named in `factory_marker_root`; deletes the rest in one `BEGIN IMMEDIATE`; and unlinks their files plus orphan blob files after the commit. Marker rows are never deleted. The 90-day retention default is a placeholder pending the owner's decision. Library only: nothing calls it yet.
