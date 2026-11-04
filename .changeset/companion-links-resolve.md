---
"@titan-design/explainer": minor
---

A repo run's companion links now resolve end to end. Resolve reads the script stage's `chapter-links` when the run has them and fills each `companion-link` beat's `slots` (`title`, `section`, `href`) from its chapter's link. A card whose chapter has no link is noted and left for template fill. Export links the `companion` artifact into the theater folder as exactly `companion.md`, beside the video, whether or not `bridge.json` lists it, so the relative `companion.md#<anchor>` hrefs open the right section. The resolve stage version changes to `pp7` and the run workflow version to `tp4107`.
