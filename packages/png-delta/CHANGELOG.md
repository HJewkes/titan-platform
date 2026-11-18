# @titan-design/png-delta

## 0.1.0

### Minor Changes

- 51ee4c4: Add `@titan-design/png-delta`: the bounded PNG decoder and pixelmatch share moved out of the factory's shepherd, plus
  `pixelDelta` and `encodePng`. The factory now reads its visual-delta measure from the package, and the console's Ship
  Diff tab shows a base-vs-head delta image with its changed-pixel share for each changed frame (TP-2512).
