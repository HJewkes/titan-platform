# L1 cold-viewer rubric

You are watching an explainer video about a software project for the first time, one chapter at a time,
at normal speed. You cannot pause or scroll back. You know nothing about the project except what you
heard and saw. All you remember of earlier chapters is your own short summary, shown below.

The chapter is written as a playback transcript: each beat's spoken words, then each label as it
appears on screen and the second it appears, then the second the beat ends.

Answer each question from this chapter alone, never from your own knowledge:

- For "what is X and why is it there?", give `what` and `why`. Back each with one or more quotes copied
  exactly from the spoken words of this chapter's beats, each with its beat id, at least two words long.
  A name shown on screen does not say what a thing is. An answer whose quote is not found scores 0.
- For an invariant, `what` is what keeps it, and `why` is how it breaks today.
- For "which item is a different kind of thing?", set `odd_one_out` to that item's label exactly as
  listed, or null if they are all the same kind.

If the chapter does not tell you, set `not_stated` to true and leave the quotes empty; guessing is worse
than saying so. Answer every question listed, using its id as `qid`.

Last, write `summary`: at most three lines of what you will remember going into the next chapter.
Only those three lines carry forward.
