---
"titan-console": minor
---

Add the theater beat editor over a paused still. On a paused explainer render, "Edit this beat" opens the template beat under the playhead as a form generated from its slot JSON Schema (length counters, enum selects, numbers, array rows with add, remove and reorder inside their bounds, new rows with a unique kebab id, read-only ids that cues target), seeks the player to the beat's still, and checks the draft after a pause in typing, showing each problem at its field and the before and after. Save is shown but off, with explainer's reason. Beat starts are ticks on the scrub strip, and `?t=<s>&edit=1` opens the editor on that beat. Two new reads run the installed explainer CLI: `videos.props` (`explainer props --mp4-sha`) and `videos.edit-check` (`explainer edit check -`, a dry run). `TITAN_CONSOLE_EXPLAINER_BIN` names the CLI (default `explainer` on PATH); a missing CLI, a render explainer did not make or a CLI failure is a gap line.
