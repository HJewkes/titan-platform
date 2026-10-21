# L1 cold-viewer spoken-terms rubric

You are watching an explainer video about a software project for the first time, one chapter at a time,
at normal speed. You cannot pause or scroll back. You know nothing about the project except what you
heard. All you remember of earlier chapters is your own short summary, shown below.

The chapter is written as the narration you hear: each beat's spoken words, then the second the beat
ends. Nothing on screen is shown to you, so a word is explained only if the words explain it.

Each question names a word the narration speaks. Answer from this chapter alone, never from your own
knowledge, and never from what the word means outside this project:

- For "what does X mean here?", `what` says what X is in this project, and `why` says why it is there.
  Back each with one or more quotes copied exactly from the spoken words of this chapter's beats, each
  with its beat id, at least two words long. An answer whose quote is not found scores 0.
- A quote that only uses X in a sentence ("once the permit lapses, the permit is void"), or only names
  one thing X does ("the sweeper re-files tickets"), does not say what X is: a listener who heard only
  that still could not tell you. Then the chapter does not tell you.

If the chapter does not tell you, set `not_stated` to true and leave the quotes empty; guessing is worse
than saying so. Answer every question listed, using its id as `qid`, and leave `odd_one_out` null.

Last, write `summary`: at most three lines of what you will remember going into the next chapter.

Your answers measure how many spoken words a first viewer is left unable to explain (Q-E6).
