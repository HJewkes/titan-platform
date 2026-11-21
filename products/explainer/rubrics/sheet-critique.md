# Sheet critique rubric

You are reviewing stills from a short explainer video. Each attached image is a contact sheet: a grid of
frames cut from the video, one per moment that matters. Under each frame a dark strip names the beat, the
cut and the time in seconds from the start of the video. A list of every cell (beat and time) follows this
rubric. Judge only what the stills show. Motion, sound and narration are out of scope here.

This call is one pass of four. The pass is named at the end of the prompt. Look at every sheet through that
pass's lens, report what it finds, and score all four dimensions as that pass sees them.

## Findings

Every finding names one cell: its `beat` and its time `t`, both copied from the cell list. Do not invent a
cell, and do not name a cell that is not on a sheet. A finding that points at no listed cell is thrown away.
When a problem spans several cells, name the clearest one.

Each finding says what is wrong (`problem`) and the smallest edit that would fix it (`change`). Rate its
`severity` from 1 (a nit) to 5 (a viewer would be misled or lost). Add every tag from the tells list that the
finding shows; leave `tags` empty when none applies.

Report nothing you cannot point at. Three sharp findings beat ten vague ones.

## Scores

Score each dimension from 0 to 10, where 10 means no change would help.

- `design`: layout, type, spacing, colour and contrast. Does the frame look made on purpose?
- `clarity`: can a viewer tell at a glance what to look at and what it means?
- `idea`: does each frame carry one point that moves the explanation forward?
- `content`: are the words, numbers and labels on screen accurate, specific and supported?

## Pass: first-glance

Give each frame about one second. What does the eye land on first, and is that the thing that matters? Flag
frames where nothing leads, where two things compete, or where the main point needs a second look to find.

## Pass: hierarchy

Read the order of importance on each frame: size, weight, position and contrast. Flag a headline that is
smaller or fainter than its support, a label that outweighs the thing it labels, crowding, and text that a
phone-sized screen could not read.

## Pass: evidence

Check what the frames claim. Flag a number, percentage or chart that nothing on screen supports or sources,
a diagram that contradicts its caption, and a label that names something the frame does not show. A number
with no visible basis is tagged `unsupported-number`.

## Pass: polish

Look for finish. Flag text that is clipped or overlaps, misaligned edges, inconsistent colours or type across
cells, stray artifacts, and empty space that looks accidental rather than chosen.

## Tells

These are habits that make a frame look machine-made and generic. Watch for them in every pass, and tag each
finding that shows one with the id given here.

- `glow-or-gradient`: a soft radial glow, halo, or colour gradient used as decoration behind or around
  content.
- `eyebrow-label`: a small all-caps tag line sitting above a headline, adding a category word and nothing
  else.
- `numbered-steps`: big ordinal markers such as 01, 02, 03 standing in for structure the content does not
  have.
- `three-card-row`: three equal cards side by side, each an icon, a title and a line, regardless of whether
  the idea has three parts.
- `dark-void-background`: content floating on a near-black empty field with nothing anchoring it.
- `sameness-run`: three or more cells in a row that share one layout and differ only in their words. Name
  the first cell of the run.
- `unsupported-number`: a figure on screen with no visible basis (see the evidence pass).
