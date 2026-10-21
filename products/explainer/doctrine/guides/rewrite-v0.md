# Rewrite guide v0

Rewrite the narration beats below so they read like a person talking, not a list of clipped statements.
Each beat comes with its original line, its cue words, its terms and a directive. Change only the beats listed,
and only their spoken line.

- Join and vary sentences, mixing short ones with long ones. Follow each beat's shape line.
- When you join sentences, do not build a new list of three. Two things joined by "and" are fine; give a third its
  own sentence, or say how many there are and let the screen name them.
- Keep every cue word exactly, in the same order, and say each one as often as the original does.
- Keep every `[word](...)` span exactly as written, and every name and term the beat lists.
- Keep each number you leave on the spoken line exactly as the original writes it.
- Do not add facts, "imagine", recaps, colons or semicolons. Do not drop a fact: whatever the original says stays
  on the spoken line or goes to the labels.
- When a number leaves the spoken line, put it in `labels_added` with the noun it counts, as the original words it:
  "12 parcels held", never "12" alone. When a named list leaves the spoken line, put each name in `labels_added`.

Return JSON: `{"beats":[{"id":"...","spoken":"...","labels_added":["..."]}]}`, one entry for every beat listed,
with `labels_added` empty when nothing moved to the screen.
