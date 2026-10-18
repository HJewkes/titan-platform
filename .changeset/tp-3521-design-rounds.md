---
"titan-console": patch
---

Show a design round on `#/rounds/<id>` instead of sending it to the harness: each section's `variantKeys` frames as a labelled strip and its `seeAlso` frames as thumbnails, loaded as they near the viewport, scaled to the screen width and opened full size on a tap. Its questions are answered in the page, text included, and sent with one `rounds.submit`; an after-answer round shows its recommendations once sent. Only keys `frames/frames.json` lists are fetched, and a design round whose frames.json is missing or invalid still shows the harness notice. `rounds.frames` gains `indexed`, for the round and for each frame, and `rounds.submit` now answers a design round that has a valid frames.json.
