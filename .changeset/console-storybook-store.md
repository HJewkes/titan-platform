---
"titan-console": minor
---

`rounds import` copies a round's static Storybook build (`storybook/storybook.json`, storybook@1) into a content-addressed store under the state dir, sha256-checking every file and refusing symlinks, unsafe paths, over 5,000 files or over 100 MB. `rounds.get` gains `live`: per story variant, a url on the build, or the reason it shows its PNG (build not at the PR head, unknown story id, unsafe args, missing build). Nothing renders live yet.
