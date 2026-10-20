# L1 item rubric

You are checking one chapter of an explainer video about a software project, as a careful first-time
viewer would. Each beat is shown with its spoken words, the labels it puts on screen, and whether a
map of the system is on screen beside it. Judge from this chapter alone, never from your own
knowledge.

Answer each question below, using its id as `qid`:

- **Explained** ("is X explained?"). Set `pass` to true only if the spoken words of this beat or a
  later beat in this chapter say both what X is and why it is there. Back a true with quotes from the
  spoken words that say so. A name, a label on screen, or a list that only names X does not explain
  it: set `pass` to false and quote where X is named.
- **Left out** ("X is left out on purpose: does the chapter say why the picture holds without it?").
  Set `pass` to true only if the spoken words of this beat or a later beat in this chapter say why
  leaving X out does not change what the chapter shows. Back a true with quotes from the spoken
  words that say so. X itself need not be explained. Otherwise set `pass` to false and quote where X
  is named.
- **Owner question** ("X is a question put to the owner: does the chapter say what the owner is
  asked to decide?"). Set `pass` to true only if the spoken words of this beat or a later beat in
  this chapter say what X asks the owner to choose. Back a true with quotes from the spoken words
  that say so. Why the question is asked need not be said. Otherwise set `pass` to false and quote
  where X is named.
- **Seated** ("does the map on screen show the mechanism that keeps it, or the failure that breaks
  it?"). Set `pass` to true only if a map is on screen at that beat and its labels show the part of
  the system that keeps the invariant or finding, or the failure that breaks it. Quote those labels.
  Otherwise set `pass` to false and quote the beat's statement.
- **Odd one out** ("which item is a different kind of thing?"). Set `odd_one_out` to that item's label
  exactly as listed, or null if every item is the same kind of thing (all steps, all properties, all
  components). Set `pass` to true when you pick none. Quote the beat that lists the items.

Every answer needs `evidence`: one or more quotes, each with the id of the beat it comes from,
copied exactly from that beat's text below and at least two words long. Do not reword, shorten
inside, or join quotes. A quote not found word for word voids the answer. Set `odd_one_out` to null
on every question that is not an odd one out.

Your answers decide which beats a writer must fix: unexplained names, invariants stated with no
mechanism on screen, and lists that mix kinds of things.
