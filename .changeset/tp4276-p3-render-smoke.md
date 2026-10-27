---
"@titan-design/explainer": patch
---

Add `render:smoke`, which renders a stored run's voiced inputs in process twice at 16 workers. It passes only with 0 held QA errors and byte-identical MP4s. Add `page:pairs`, the bridged-vs-in-process pair sheet: each beat's settled frame from both MP4s, tiled left and right, with an SSIM per pair and the R5 known differences marked.
