# Planner guide: repo-tour

<!-- Generated from doctrine/types/repo-tour.yaml (profile 0.3.0) by `explainer guide types`. Do not edit. -->

After one watch the viewer can say what the repo is for, how it is laid out, where execution starts, its 2-4 key features and where each lives, one or two things worth knowing, and what titan should adopt, adapt or avoid, and where to read first.

## Audience

owner-internal: The owner and titan agents: expert in code, new to this subject. Titan-relative verdicts are on screen.

## Runtime

Aim for 10:00, within 8:00-12:00. Above 15:00, split into episodes.

## Structure

Macro: scqa-c4. The chapters play in this order every time; they are the viewer's map.

- **cold-open** (25-40 s): The thing in action or its pain, what it is in one line, and the verdict line. Beats: hook, promise, scorecard; must include hook.
- **purpose** (45-75 s): Who uses it and which problem it solves; the system as one box among its users. Beats: context-map, claim-card, stat.
- **entry-points** (60-90 s): Real, verified commands; one user flow; the running example introduced. Beats: entry-points, user-flow.
- **architecture** (60-120 s): Packages named one by one, runtime arrows, a size or hotspot overlay. Beats: arch-map, metrics-panel, dsm; must include arch-map.
- **request-walk** (60-120 s): The running example traced from the entry point, slow pass then fast replay. Beats: request-walk, sequence.
- **features** (120-480 s): Two to four feature chapters, each opening at its map station with a question and ending on a verdict chip. Beats: chapter-open, zoom, info-flow, schema, sequence, code-walk, sim, companion-link, verdict-chip; must include chapter-open, verdict-chip.
- **worth-knowing** (45-120 s): One algorithm and/or two or three surprising facts. Beats: algo-trace, sim, fact-flash, docs-vs-code, history-why.
- **health** (45-90 s): Hotspots, test gaps, coupling, licences and risks for us, pinned on the map. Beats: issue-pin, metrics-panel, fix.
- **scorecard** (45-90 s): The scorecard fills its last rows: adopt, adapt, avoid, each pointing back to its chapter. Beats: scorecard; must include scorecard.
- **read-first** (15-30 s): Five files lit on the map, then the button. Beats: reading-list, companion-link, button, outro; must include button.

## Hook and ending

- Hook: State the verdict in one line by 10% of runtime; grey scorecard rows open the loops the chapters close.
- Ending: scorecard+button

## Cuts

- **tour-short** (5:00-7:00): The owner wants the tour in less time: keep cold-open, purpose, architecture, request-walk, one feature, scorecard and read-first.
- **review-digest** (2:00-3:00): A repo in the routine review batch, not one the owner is deciding on (owner Q8 A).
- **argument** (3:30-5:00): One idea from the repo should land for an outside viewer.

## Series

May repeat from the previous video: frame-chrome, intro-outro, chapter-rail, house-look, captions, voice, structure, chapter-labels.
Must differ from the previous video: hook-kind, close-kind, function-mix, component-histogram, framing-sequence, signature-layer, style-pack, stock-lines.

## Audition

Sample 3 or more spines, each with a different beat system inside the fixed chapters, and stop at the storyboard.

## Structures

The spine you write follows the structure you pick. The runner-up goes in the render notes.

### scqa-c4

A verdict first, then fixed chapters from context down to code; the chapters are the viewer's map. (video-types study §2.2 (the repo tour's fixed C4 chapter skeleton under an SCQA verdict))

Spine sections: 1. Verdict; 2. Map stations; 3. Running example; 4. Read first.

Beat systems: **martini-glass** over every block; **chapter-question** inside features; **lab-cycle** inside features.

## Beat systems

A beat system is the beat order inside a structure's blocks, not a structure of its own. Play the steps in order; a step lands in the same block as the one before it or a later one, and an optional step may be dropped.

### martini-glass

An authored stem (verdict, map, one traced request, the key ideas, the scorecard) that opens into a companion doc the viewer explores. (video-profiles plan §B.3 (the martini glass) [W47])

1. hook or promise: The verdict line, with the scorecard rows still grey.
2. context-map or arch-map: The map, which never moves after this.
3. request-walk: One request traced through the map.
4. chapter-open: The two to four ideas, each opened at its map station.
5. scorecard: The scorecard, filled.
6. companion-link: The bowl: the companion doc holds every topic and file the stem left out.
7. button: The button.

### chapter-question

A chapter that opens on a question at its map station, answers it in the code, and closes on a verdict chip. (video-types study §2.2 (each chapter opens a question at its map station and closes a scorecard row))

1. chapter-open: The chapter opens at its map station with the question it answers.
2. zoom or info-flow or schema or sequence or code-walk: The answer, shown where it lives.
3. companion-link (optional): Where the rest of the topic lives in the companion doc.
4. verdict-chip: The verdict chip that closes the chapter's scorecard row.

### lab-cycle

A question, a model run live to answer it, the reading, and what it means. (video-profiles plan §B.2 and §B.3 (a lab cycle with a sim))

1. chapter-open or hook or claim-card: The question, or the number that should not be true.
2. sim: The model, run live: the viewer watches the claim happen.
3. replot or stat or compare (optional): The reading, on the same axes as the source.
4. verdict-chip or claim-card or takeaways: What it means.

## Beats

- **hook** (open, 4-15 s): The stake or the thing in action, before any context.
- **promise** (open, 4-12 s): What the video will show, as the chapters ahead.
- **scorecard** (close, 10-35 s): Every call on one card, each pointing back to its chapter.
- **context-map** (explain, 8-20 s): The system as one box among its users and neighbours.
- **claim-card** (explain, 4-14 s): One claim, stated plainly, with its source.
- **stat** (evidence, 4-12 s): One to four numbers that carry the point.
- **entry-points** (explain, 8-25 s): The real commands or entry points a user starts from.
- **user-flow** (explain, 8-25 s): One user's path through the thing, step by step.
- **arch-map** (explain, 10-40 s): The system's parts and how they connect; the map later beats return to.
- **metrics-panel** (evidence, 6-18 s): A small table: measure, today, target.
- **dsm** (evidence, 8-25 s): A dependency matrix showing coupling between modules.
- **request-walk** (explain, 15-60 s): One running example traced across the map, hop by hop.
- **sequence** (explain, 10-35 s): Who calls whom, in order: actors, lifelines and messages.
- **chapter-open** (navigate, 2-6 s): A chapter opening at its station on the map, with its question.
- **zoom** (explain, 6-25 s): A push into one part of the map to show what is inside it.
- **info-flow** (explain, 8-30 s): How data or work moves through the parts, left to right.
- **schema** (explain, 8-25 s): The data model: tables, keys and relations.
- **code-walk** (evidence, 10-35 s): A short code excerpt with a moving focus band.
- **sim** (evidence, 12-45 s): A small model we run, sweeping one parameter.
- **companion-link** (navigate, 2-6 s): A card pointing into the companion doc for reference kept off screen.
- **verdict-chip** (close, 2-8 s): A chapter's call as one chip and a reason.
- **algo-trace** (explain, 12-45 s): An algorithm stepping through real state.
- **fact-flash** (evidence, 3-9 s): One to four quick facts at speed.
- **docs-vs-code** (evidence, 8-25 s): What the docs say beside what the code does.
- **history-why** (explain, 8-25 s): A past decision and why, quoted from the record.
- **issue-pin** (evidence, 6-20 s): Problems pinned where they live on the map.
- **fix** (evidence, 8-25 s): The change that fixes an issue, as a small diff.
- **reading-list** (close, 6-18 s): The files to read first, and why.
- **button** (close, 3-8 s): The one action to take next.
- **outro** (close, 2-6 s): The closing line.

## Rules for the plan stage

- **owner-FB2.1**: Keep a ledger of every item the video names, each with a kind and the beat that defines it, and define an item before using it.
- **owner-FB4.1**: A list holds one kind of item.
- **owner-FB6.1**: Seat each invariant in an architecture row that keeps it.
