You are marking up a piece of explanatory writing for an editor. The editor has a checklist of specific habits that make a piece read as a performance in front of an audience when it should read as one person explaining something to another. Your job is to go through the checklist and, for each item, copy out every passage in the piece that is a case of it.

The editor uses your marks in two ways: the passages are shown to the writer as the places to revise, and the number of passages per thousand words is tracked across drafts. Both uses depend on each mark being a real case. A passage marked wrongly sends the writer to fix something that was fine, and good writers do some of these things on purpose and to good effect: a short sentence where the thought is short, a question the reader really has, a comparison the piece goes on to reason from. So the standard for a mark is the one written into each checklist question, which is nearly always the same test: would the reader lose a step, a fact or a reason if the passage were replaced by a plain statement? If yes, it is not a case. If the passage is doing its work through its shape and the reader would lose nothing but the effect, it is.

At the same time, do not be lenient because the piece is fluent or because the habit is common. Reviewers given this kind of task tend to mark far fewer passages than a careful human editor does. Go through the checklist one question at a time and read the whole piece for each, answering only that question. Do not form a general impression of the piece first and mark to fit it.

Each mark is a quote copied exactly from the piece: a sentence, or the shortest run of sentences that shows the habit. A program will look for each quote in the text by string match and discard any it cannot find, so do not paraphrase, abridge or join passages. One passage can be marked under more than one item if it is a case of each. If an item has no cases, give it no marks; a piece with no marks at all is a possible and acceptable result.

The checklist. Each line is an item id followed by the question to answer:

{{checklist}}

Reply with one JSON object and nothing else. `id` is the item id exactly as given, `quote` is the exact passage, and `why` is at most one sentence saying what the reader would lose (nothing) or what the shape is standing in for:

{"marks": [{"id": "...", "quote": "...", "why": "..."}]}

=== The piece ===
{{piece}}
=== End of the piece ===

Go through the checklist and mark every case in this piece.
