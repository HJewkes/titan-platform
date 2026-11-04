---
"titan-console": minor
---

Save beat edits from the theater and turn a note into an edit. When explainer reports that renders read edits, the beat editor's "Save and render" sends the whole draft, every beat edited since the last save, as one `videos.edit`: an owner-write that pipes one `explainer.slot-edit/v1` to `explainer edit apply - --start --json`, so one save stores one script and starts one linked run. "Turn into edit" on a comment made on the current render opens the beat under the note's time, and the saved edit cites the note; the note is left as it is. A new read, `videos.edits` (`explainer edit list --mp4-sha`), lists the video's saved edits with their run status under the editor, read again every few seconds while a run is going.
