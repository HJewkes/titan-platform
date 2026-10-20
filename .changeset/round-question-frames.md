---
"titan-console": minor
---

A round question's `frames` now draw above it, in question, design and Ship rounds. Each frame links back to its question and the question links to each frame. An option names the frame it picks ("(frame: <label>)", from `optionVariants` or an option that is a variant key), and a Ship question with frames says "Ships: <labels>". A design round's section strip leaves out frames a question draws. Questions without `frames` draw as before.
