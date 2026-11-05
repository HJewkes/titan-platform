---
"@titan-design/factory": patch
---

Add the pure snapshot measure for Shepherd's visual-diff threshold: `snapshotShare` decodes a base and a head PNG and returns the pixelmatch share of changed pixels within the content box (1 when the sizes differ, antialiased pixels ignored), `contentBox` bounds the pixels that differ from the corner colour, and `componentOf` names the component a story or specimen snapshot shows. Adds `pngjs` and `pixelmatch`. Nothing reads it yet.
