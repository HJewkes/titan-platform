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
- When a number leaves the spoken line, do not put a vague word in its place; keep the number as the original says
  it, or cut the clause and let the label carry it.
- Keep every clause as concrete as the original: name the thing, the file, the person or the example it names. Never
  trade a named thing for "things", "stuff", "various parts" or "a number of" anything.
- Do not add facts, "imagine", recaps, colons or semicolons. Do not drop a fact: whatever the original says stays
  on the spoken line or goes to the labels.
- When a number leaves the spoken line, put it in `labels_added` with the noun it counts, as the original words it:
  "12 parcels held", never "12" alone. When a named list leaves the spoken line, put each name in `labels_added`.
- A list of three that leaves the spoken line: put every item in `labels_added`, one each, keep at most a single item in
  the line, and you may say how many there are. Keep what the sentence said about the list; "there are three of them"
  alone says nothing. Example: "We skip the oven timer, glaze notes and crate labels." becomes spoken "We skip three
  things the screen lists." with labels_added ["oven timer", "glaze notes", "crate labels"].
- A beat whose directive lists stock phrases: these are words our scripts say far more often than people do. Say
  what each one means in plain words of your own, and do not swap it for another stock phrase.
- A beat whose directive starts "Your last version was not used" was rewritten before and refused. The line says
  why; fix that in this version, and do not hand back the version it describes.

Return JSON: `{"beats":[{"id":"...","spoken":"...","labels_added":["..."]}]}`, one entry for every beat listed,
with `labels_added` empty when nothing moved to the screen.
