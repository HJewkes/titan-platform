---
"@titan-design/explainer": minor
---

`eval cold` now scores a roll call's bare items in code. A list beat of three or more items, at least half of them spoken without one gloss word in any clause of the chapter, has each bare item scored 0 (`named only in a list`), whatever the viewer answers. A single bare item among glossed siblings is still graded from the answer. Cold questions also ask "what is X?" (kind `spoken-term`) for each `video.glossary` name and each spoken identifier such as `F7`, at the beat that first speaks it, unless a new item's label at or before that beat already names it. An unexplained spoken term counts as an undefined item. `ColdInput` takes an optional `glossary`, read from both spike and script/v1 files. The eval_version changes.
