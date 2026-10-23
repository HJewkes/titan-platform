# Planner guide: daily-overview

<!-- Generated from doctrine/types/daily-overview.yaml (profile 0.3.0) by `explainer guide types`. Do not edit. -->

What the owner must know and decide today: the bottom line, the facts behind it, the decisions waiting, then the rest at speed.

## Audience

owner-internal: The owner and titan agents: expert in code, new to this subject. Titan-relative verdicts are on screen.

## Runtime

Aim for 2:30, within 2:00-4:00. Above 5:00, split into episodes.

## Structure

Pick the macro structure: ask these in order and stop at the first yes.

1. Does the owner queue hold an old blocking item? Then **scqa**.
2. Did one event cascade through the day? Then **timeline**.
3. Is the day best told as work moving across the board? Then **board-walk**.
4. None of these: **bluf**.

Block order per macro:

- **bluf**: bottom-line → decisions → facts → segments → ask
- **scqa**: bottom-line → situation → decisions → ask
- **timeline**: bottom-line → day → decisions → ask
- **board-walk**: bottom-line → board → decisions → ask

Blocks:

- **bottom-line** (10-25 s): The verdict of the day and how many items need the owner. Beats: verdict-card, claim-card, stat; must include verdict-card.
- **decisions** (20-50 s): The top decisions, each with its recommendation. Beats: list, claim-card.
- **facts** (20-50 s): The two or three facts behind the bottom line. Beats: stat, metrics-panel, chart, forecast.
- **situation** (20-45 s): The blocking item and what waiting on it costs. Beats: issue-pin, attempt, stat, history.
- **day** (30-70 s): The day on a timeline, from the first event to its last effect. Beats: gantt, history, sequence.
- **board** (30-70 s): Work moving across the board. Beats: kanban-flow, metrics-panel, chart; must include kanban-flow.
- **segments** (30-80 s): Background on demand: the remaining segments at speed, ranked by change. Beats: fact-flash, chart, metrics-panel, forecast, attempt, issue-pin, stat.
- **ask** (10-20 s): What the owner does next, then the button to the digest. Beats: button; must include button.

## Hook and ending

- Hook: The bottom line and the count of items that need the owner, in the first 20 s.
- Ending: button

## Series

May repeat from the previous video: frame-chrome, intro-outro, house-look, captions, voice.
Must differ from the previous video: structure, hook-kind, chapter-labels, close-kind, function-mix, component-histogram, framing-sequence, signature-layer, style-pack, stock-lines, lead-story, featured-visual.

## Audition

Sample 3 or more spines, each under a different macro structure, and stop at the storyboard.

## Structures

The spine you write follows the structure you pick. The runner-up goes in the render notes.

### scqa

Situation, complication, question, then the answer by 25% of runtime and its supports by importance. (story-structure §2.7 (Minto pyramid / SCQA), §4 row 1)

Spine sections: 1. Situation; 2. Complication; 3. Question and answer; 4. Supports, by importance.

Beat systems: **journey-of-attempts** inside situation.

### timeline

One event and its cascade, told in time order from the first event to its last effect. (video-profiles plan §B.4 (the cascade day))

Spine sections: 1. Bottom line; 2. Cascade; 3. Decisions left.

### board-walk

Work moving across the board, column by column, then the decisions it leaves. (video-profiles plan §B.4 (the board walk))

Spine sections: 1. Bottom line; 2. Moves; 3. Decisions left.

Beat systems: **board-walk** over every block.

### bluf

The bottom line first, the decisions waiting, the facts behind them, then the rest at speed. (video-profiles plan §B.4 (bottom line up front))

Spine sections: 1. Bottom line; 2. Decisions; 3. Segments.

Beat systems: **bluf** over every block; **journey-of-attempts** inside segments.

## Beat systems

A beat system is the beat order inside a structure's blocks, not a structure of its own. Play the steps in order; a step lands in the same block as the one before it or a later one, and an optional step may be dropped.

### bluf

The bottom line first, then what the viewer must decide, the facts behind it, and the rest only on demand. (video-profiles plan §B.4 (BLUF) [W45]; the order follows the bluf structure and the §B.4 example spine)

1. verdict-card: The bottom line in one sentence, with the count of items that need the viewer.
2. list or claim-card: What the viewer must decide, each with its recommendation.
3. stat or metrics-panel or chart or forecast: The two or three facts behind the bottom line.
4. fact-flash or chart or metrics-panel or forecast (optional): Background on demand: the remaining segments at speed, ranked by change.
5. button: The button to the full digest.

### journey-of-attempts

What was tried, where it broke and why, the fix, and what shows it now holds. (video-profiles plan §B.1 and §B.4 (journey of attempts) [W41])

1. attempt: What was tried.
2. issue-pin or sequence or info-flow: Where it broke.
3. history-why or history or sequence or info-flow (optional): Why it broke.
4. fix or code-walk (optional): The fix.
5. proof or stat: What holds now: the proof or the number.

### board-walk

The board as it stands, the moves replayed column by column, then the decisions the board leaves. (video-profiles plan §B.4 (the board walk))

1. verdict-card: The bottom line, and how much moved.
2. kanban-flow: The board as it stands now.
3. kanban-flow: The moves replayed, column by column, real task data moving.
4. metrics-panel or chart (optional): What the moves add up to.
5. list or claim-card: The decisions the board leaves, each with its recommendation.
6. button: What to do next.

## Beats

- **verdict-card** (open, 5-16 s): The bottom line first: an imperative one-line summary, the call and why.
- **claim-card** (explain, 4-14 s): One claim, stated plainly, with its source.
- **stat** (evidence, 4-12 s): One to four numbers that carry the point.
- **list** (explain, 5-18 s): Up to five marked rows: tick, cross, risk, open or dot.
- **metrics-panel** (evidence, 6-18 s): A small table: measure, today, target.
- **chart** (evidence, 6-20 s): A small chart: bars, a line, a spark or a gauge.
- **forecast** (evidence, 6-20 s): Where a measure is heading, with p50 and p80.
- **issue-pin** (evidence, 6-20 s): Problems pinned where they live on the map.
- **attempt** (explain, 6-22 s): What was tried, what happened and why.
- **history** (explain, 8-30 s): Dated events on a time axis with a playhead.
- **gantt** (evidence, 10-35 s): Tasks on a date axis, with milestones.
- **sequence** (explain, 10-35 s): Who calls whom, in order: actors, lifelines and messages.
- **kanban-flow** (evidence, 10-35 s): Work moving across the board's columns.
- **fact-flash** (evidence, 3-9 s): One to four quick facts at speed.
- **button** (close, 3-8 s): The one action to take next.

## Rules for the plan stage

- **owner-FB2.1**: Keep a ledger of every item the video names, each with a kind and the beat that defines it, and define an item before using it.
- **owner-FB4.1**: A list holds one kind of item.
- **owner-FB6.1**: Seat each invariant in an architecture row that keeps it.
