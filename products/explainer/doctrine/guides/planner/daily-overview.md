# Planner guide: daily-overview

<!-- Generated from doctrine/types/daily-overview.yaml (profile 0.5.0) by `explainer guide types`. Do not edit. -->

What the factory got done against its goals: each lane and what it moved, the ships that mattered most, the side quests, the stats, then what slows us down and what to change.

## Audience

owner-internal: The owner and titan agents: expert in code, new to this subject. Titan-relative verdicts are on screen.

## Runtime

Aim for 3:00, within 2:00-4:00. Above 5:00, split into episodes.

## Structure

Macro: goal-walk. The chapters play in this order every time; they are the viewer's map.

- **bottom-line** (10-20 s): The verdict of the day, how much merged and how much was decided. Beats: verdict-card, stat; must include verdict-card.
- **goals** (15-25 s): The goals each lane works toward, or merges by lane. Beats: list, chart.
- **lanes** (60-90 s): Each lane in turn: a lead beat, then one continuation beat per named thread, labelled by lane, and the count of the rest. Beats: list, chart, kanban-flow.
- **ships** (25-45 s): The two or three most consequential ships, each described with a diagram or chart. Beats: compare, arch-map, chart, claim-card.
- **side-quests** (8-15 s): The side quests, named as side quests. Beats: list, fact-flash.
- **stats** (12-20 s): Spend, its split, merges, cost per merge and the trend against the prior days. Beats: stat, chart, metrics-panel.
- **reflection** (15-30 s): What slows us down, the top priorities, and proposed changes to how we work. Beats: list, claim-card.
- **ask** (5-10 s): What the owner does next, then the button to the digest. Beats: button; must include button.

## Hook and ending

- Hook: The verdict of the day with how much merged and was decided, in the first 20 s.
- Ending: button

## Series

May repeat from the previous video: frame-chrome, intro-outro, house-look, captions, voice, structure, chapter-labels.
Must differ from the previous video: hook-kind, close-kind, function-mix, component-histogram, framing-sequence, signature-layer, style-pack, stock-lines, lead-story, featured-visual.

## Audition

Sample 3 or more spines, each with a different beat system inside the fixed chapters, and stop at the storyboard.

## Structures

The spine you write follows the structure you pick. The runner-up goes in the render notes.

### goal-walk

The bottom line, the goals, each parallel lane and what it moved toward its goal, the ships that mattered most, the side quests, the stats, then a reflection and the ask. (TP-4125 plan §3 S5 (the daily as a report against goals, lane by lane))

Spine sections: 1. Bottom line; 2. Goals; 3. Lanes; 4. Ships, by consequence; 5. Reflection.

Beat systems: **bluf** over every block; **board-walk** over every block.

## Beat systems

A beat system is the beat order inside a structure's blocks, not a structure of its own. Play the steps in order; a step lands in the same block as the one before it or a later one, and an optional step may be dropped.

### bluf

The bottom line first, then what the viewer must decide, the facts behind it, and the rest only on demand. (video-profiles plan §B.4 (BLUF) [W45]; the order follows the bluf structure and the §B.4 example spine)

1. verdict-card: The bottom line in one sentence, with the count of items that need the viewer.
2. list or claim-card: What the viewer must decide, each with its recommendation.
3. stat or metrics-panel or chart or forecast: The two or three facts behind the bottom line.
4. fact-flash or chart or metrics-panel or forecast (optional): Background on demand: the remaining segments at speed, ranked by change.
5. button: The button to the full digest.

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
- **stat** (evidence, 4-12 s): One to four numbers that carry the point.
- **list** (explain, 5-18 s): Up to five marked rows: tick, cross, risk, open or dot.
- **chart** (evidence, 6-20 s): A small chart: bars, a line, a spark or a gauge.
- **kanban-flow** (evidence, 10-35 s): Work moving across the board's columns.
- **compare** (evidence, 8-25 s): Two things side by side, row by row.
- **arch-map** (explain, 10-40 s): The system's parts and how they connect; the map later beats return to.
- **claim-card** (explain, 4-14 s): One claim, stated plainly, with its source.
- **fact-flash** (evidence, 3-9 s): One to four quick facts at speed.
- **metrics-panel** (evidence, 6-18 s): A small table: measure, today, target.
- **button** (close, 3-8 s): The one action to take next.

## Rules for the plan stage

- **owner-FB2.1**: Keep a ledger of every item the video names, each with a kind and the beat that defines it, and define an item before using it.
- **owner-FB4.1**: A list holds one kind of item.
- **owner-FB6.1**: Seat each invariant in an architecture row that keeps it.
