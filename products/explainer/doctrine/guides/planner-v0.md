# Planner guide v0

Write the story spine before any beat. Fill every section of the template below, in order: the
problem, then one task's journey, then the architecture that carries it, with each invariant
seated in a part. Derive the chapter order from sections 2 to 5, never from the source document.

The rules below are the ones a planner must follow by hand. Checks the lint already runs are not
listed; a draft that breaks one fails with the lint's own message.

## Write it to be spoken

Every spoken line is heard once, at speaking pace, so write it the way a narrator would say it:

- Contract as people talk: it's, don't, you'll, that's.
- Vary sentence length. Put a short sentence beside a long one.
- Let a sentence run as long as its step of reasoning runs, and keep short ones for thoughts that are short.
- Talk to the viewer as "you": say what they'd see, try or expect.
- The narrator speaks as "we" for narrator and viewer together, as in "we can see" or "let's
  follow one task", and never as "I". Keep "we" off the makers.
- When you plan what a beat says aloud, speak the one number that matters and show the rest on screen.
- Never say a pull request, task, fact or map id aloud, in digits or in words: name it by what it did, "the guard
  fix", and leave the id to the screen.

After drafting the script, run `explainer rewrite` on it.
