---
"@titan-design/factory": minor
---

Add `decodePngBounded`, a PNG decoder for snapshot blobs a pull request supplies (TP-4320 S3b). It walks every chunk before it inflates anything: exactly one IHDR, first; consecutive IDATs; nothing after IEND; 8-bit RGB or RGBA only, not interlaced; width × height at most `maxPixels`. It then inflates with a zlib `maxOutputLength` taken from the checked header, so peak memory stays bounded whatever the bytes claim. `snapshotShare` and `contentBox` now take decoded images, and pngjs is a test-only dependency.
