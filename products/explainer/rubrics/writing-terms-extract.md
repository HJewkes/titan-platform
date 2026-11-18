You are indexing the technical terms in a piece of explanatory writing. You will be given the piece. For each term it introduces you will copy out a few exact passages. A program will then find those passages in the text and measure things from their positions: how many new terms the piece introduces per thousand words, how far apart they are, how many are ever defined, and how many are set up before they are named. Nothing you write is used as a judgment of the piece. Only the terms and the positions of your quotes are used.

Because the measurements come from string positions, every quote must be copied character for character from the piece. A quote that is paraphrased, tidied, shortened in the middle or joined from two places will not be found, and will be thrown away. If a passage is long, quote its first sentence exactly instead of abridging it. If something asked for is not in the piece, give null; do not supply it yourself.

## What counts as a term

A term is a word or phrase that the piece uses as the name of something in its subject, and that a newcomer to the subject would not already know in that sense: a named part, process, quantity, method or effect. Include a term the first time it is used, whether or not the piece explains it. Include ordinary words when the piece gives them a technical sense (for instance "weight" in a piece about neural networks). Do not include everyday words used in their everyday sense, names of people, places or organisations, or units of measurement. Give each term once, in the form the piece first uses, and list terms in the order they first appear.

## What to record for each term

- `term`: the term, written exactly as it first appears in the piece.
- `first_mention`: the exact sentence in which the term first appears.
- `definition`: the exact sentence or clause in which the piece says what the thing is or does: something a reader could repeat as an answer to "what is that?" or "what does that do?". It may be the same sentence as the first mention, or come earlier or later. A sentence that only says the thing is important, or lists it among others, is not a definition. If there is none, null.
- `motivation`: the exact passage, coming before the first mention, that sets up the need for the thing before it is named: it describes the problem, the behaviour or the particular case that the term then gets attached to, so that when the name arrives the reader already has something to hang it on. Quote the sentence where that set-up begins. The set-up must come before the name and must be about this thing; general scene-setting at the start of the piece does not count. If the term is named first and explained afterwards, or never set up, null.
- `used_after`: true if, after it has been introduced, the term does work later in the piece: a later sentence relies on it to say something further. false if the term is introduced and never needed again.

Reply with one JSON object and nothing else:

{"terms": [{"term": "...", "first_mention": "...", "definition": "... or null", "motivation": "... or null", "used_after": true}]}

=== The piece ===
{{piece}}
=== End of the piece ===

Index the technical terms this piece introduces.
