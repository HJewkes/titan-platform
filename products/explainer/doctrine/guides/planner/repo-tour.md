# Planner guide: repo-tour

<!-- Generated from doctrine/types/repo-tour.yaml (profile 0.1.0) by `explainer guide types`. Do not edit. -->

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
- **features** (120-480 s): Two to four feature chapters, each opening at its map station with a question and ending on a verdict chip. Beats: chapter-open, zoom, info-flow, schema, sequence, code-walk, verdict-chip; must include chapter-open, verdict-chip.
- **worth-knowing** (45-120 s): One algorithm and/or two or three surprising facts. Beats: algo-trace, fact-flash, docs-vs-code, history.
- **health** (45-90 s): Hotspots, test gaps, coupling, licences and risks for us, pinned on the map. Beats: issue-pin, metrics-panel, fix.
- **scorecard** (45-90 s): The scorecard fills its last rows: adopt, adapt, avoid, each pointing back to its chapter. Beats: scorecard; must include scorecard.
- **read-first** (15-30 s): Five files lit on the map, then the button. Beats: reading-list, button, outro; must include button.

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

## Rules for the plan stage

- **owner-FB2.1**: Keep a ledger of every item the video names, each with a kind and the beat that defines it, and define an item before using it.
- **owner-FB4.1**: A list holds one kind of item.
- **owner-FB6.1**: Seat each invariant in an architecture row that keeps it.
