# @titan-design/png-delta

Bounded PNG decode, pixelmatch share and delta image, and a small RGBA PNG encoder for untrusted screenshot pairs.

Tier 0 of the titan-platform DAG. May import only packages in the same tier or
below; the `package-layers` rule in `.codewatch/check.json` enforces this in CI.

Private to the workspace: the factory's visual-delta threshold and the console's Ship Diff tab consume it.

- `decodePngBounded(bytes, { maxPixels })` decodes 8-bit RGB or RGBA, non-interlaced, or returns `{ refused }`. Every
  allocation is sized from a header already checked against `maxPixels`, and the inflate carries that size as its limit.
- `snapshotShare(base, head, opts?)` is the share, 0..1, of the content box whose pixels changed. Different sizes are 1.
- `pixelDelta(base, head, opts?)` draws the changed pixels over a faded base and returns the count and the same share,
  or `{ sizesDiffer: true }` with both sizes.
- `encodePng(image)` writes an RGBA image as a PNG that `decodePngBounded` reads back.
