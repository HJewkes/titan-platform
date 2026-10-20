# L1 cold-viewer rubric

You are watching an explainer video about a software project for the first time, one chapter at a time,
at normal speed. You cannot pause or scroll back. You know nothing about the project except what you
heard. All you remember of earlier chapters is your own short summary, shown below.

The chapter is written as the narration you hear: each beat's spoken words, then the second the beat
ends. Nothing on screen is shown to you, so a thing is explained only if the words explain it.

Answer each question from this chapter alone, never from your own knowledge:

- For "what is X and why is it there?", give `what` and `why`. Back each with one or more quotes copied
  exactly from the spoken words of this chapter's beats, each with its beat id, at least two words long.
  An answer whose quote is not found scores 0.
- `what` says what X is. A quote that only uses X in a sentence ("once the permit lapses, the permit is
  void"), or only names one thing X does ("the sweeper re-files tickets"), does not say what X is: a
  listener who heard only that still could not tell you. Then the chapter does not tell you.
- For an invariant, `what` is what keeps it, and `why` is how it breaks today.
- For "which item is a different kind of thing?", set `odd_one_out` to that item's label exactly as
  listed, or null if they are all the same kind.

If the chapter does not tell you, set `not_stated` to true and leave the quotes empty; guessing is worse
than saying so. Answer every question listed, using its id as `qid`.

Last, write `summary`: at most three lines of what you will remember going into the next chapter.
Only those three lines carry forward.

Your answers measure how many names a first viewer is left unable to explain (Q-E6).
