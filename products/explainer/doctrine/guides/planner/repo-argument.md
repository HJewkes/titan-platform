# Planner guide: repo-argument

<!-- Generated from doctrine/types/repo-argument.yaml (profile 0.2.0) by `explainer guide types`. Do not edit. -->

One idea from the repo lands and sticks for a senior engineer on a first watch: why it matters, how it works, and the one thing to take away.

## Audience

public-youtube: A senior engineer outside titan, watching once. No titan-relative verdict is on screen.

## Runtime

Aim for 4:00, within 3:30-5:00. Above 6:00, split into episodes.

## Structure

Pick the macro structure: ask these in order and stop at the first yes.

1. Is the viewer deciding something (adopt, fund, migrate) and the verdict is the product? Then **scqa**.
2. Is there one surprising finding: a bug, a docs-versus-behaviour contradiction, a how-is-this-possible? Then **mystery**.
3. Is there one central problem the code works through over time, at five minutes or longer? Then **three-act** (at 5:00 or longer).
4. Is there one central problem the code works through, under five minutes? Then **abt**.
5. Is the headline an elegant idea with no real problem? Then **kishotenketsu**.
6. Are the findings parallel and independent? Then **countdown**.
7. None of these: **abt**.

Block order per macro:

- **scqa**: situation → complication → answer → supports → takeaway
- **mystery**: anomaly → clues → reveal → takeaway
- **three-act**: situation → complication → struggle → resolution → takeaway
- **abt**: situation → complication → resolution → takeaway
- **kishotenketsu**: situation → development → twist → reconcile → takeaway
- **countdown**: situation → complication → countdown → takeaway

Blocks:

- **situation** (15-40 s): What the viewer already accepts, in one beat. Beats: hook, promise, context-map.
- **complication** (20-50 s): The but: the pain fact or the naive way that fails. Beats: misconception, stakes, issue-pin, stat.
- **answer** (20-40 s): The answer, by 25% of runtime. Beats: claim-card, arch-map.
- **supports** (60-120 s): The supports, ordered by importance. Beats: code-walk, info-flow, sequence, compare.
- **anomaly** (15-40 s): Cold open on the anomaly. Beats: hook, stat, docs-vs-code.
- **clues** (60-120 s): Deep dives as clues and false leads. Beats: code-walk, info-flow, zoom, history.
- **reveal** (30-60 s): The cause, shown in the code. Beats: code-walk, algo-trace, fix.
- **struggle** (60-120 s): Attempts and what each one broke. Beats: code-walk, history, sequence.
- **resolution** (40-90 s): The therefore: how the repo resolves it. Beats: code-walk, arch-map, info-flow, fix.
- **development** (40-80 s): The idea developed in its plain form. Beats: info-flow, code-walk, schema.
- **twist** (30-60 s): The unexpected angle that recasts it. Beats: compare, algo-trace, zoom.
- **reconcile** (20-40 s): The two halves joined. Beats: arch-map, claim-card.
- **countdown** (90-150 s): At most five findings, each a mini-ABT, ordered by stakes. Beats: chapter, code-walk, claim-card, stat.
- **takeaway** (15-30 s): The one thing to take away, then the button. Beats: takeaways, button, outro; must include button.

## Hook and ending

- Hook: Open on the pain or the anomaly by 0.5 s; the complication lands by 25% of runtime.
- Ending: takeaways+button

## Series

May repeat from the previous video: frame-chrome, intro-outro, house-look, captions, voice.
Must differ from the previous video: structure, hook-kind, chapter-labels, close-kind, function-mix, component-histogram, framing-sequence, signature-layer, style-pack, stock-lines.

## Audition

Sample 3 or more spines, each under a different macro structure, and stop at the storyboard.

## Structures

The spine you write follows the structure you pick. The runner-up goes in the render notes.

### scqa

Situation, complication, question, then the answer by 25% of runtime and its supports by importance. (story-structure §2.7 (Minto pyramid / SCQA), §4 row 1)

Spine sections: 1. Situation; 2. Complication; 3. Question and answer; 4. Supports, by importance.

### mystery

Cold open on an anomaly, follow the clues and false leads, then reveal the cause. (story-structure §2.10 (mystery / open loop), §4 row 2)

Spine sections: 1. Anomaly; 2. Clues and false leads; 3. Reveal; 4. Open loops.

### three-act

Setup, a confrontation of attempts that each break something, then the resolution. (story-structure §2.1 (three-act), §4 row 3 at five minutes or longer)

Spine sections: 1. Setup; 2. Attempts; 3. Resolution.

### abt

And (what holds), but (the problem), therefore (the resolution), in under five minutes. (story-structure §2.6 (And-But-Therefore), §4 row 3 under five minutes and the default row)

Spine sections: 1. ABT sentence; 2. And; 3. But; 4. Therefore.

### kishotenketsu

Introduce, develop, twist with an unexpected angle, reconcile: an elegant idea with no conflict. (story-structure §2.4 (kishōtenketsu), §4 row 5)

Spine sections: 1. Idea; 2. Development; 3. Twist; 4. Reconciliation.

### countdown

Parallel findings counted down by stakes inside an ABT frame, never a bare list. (story-structure §2.9 (listicle / countdown), §4 row 6)

Spine sections: 1. Frame; 2. Countdown; 3. What they add up to.

Beat systems: **countdown-rung** inside countdown.

## Beat systems

A beat system is the beat order inside a structure's blocks, not a structure of its own. Play the steps in order; a step lands in the same block as the one before it or a later one, and an optional step may be dropped.

### countdown-rung

One rung of a countdown: its rank, then and, but, therefore, so the item is a small argument rather than a list entry. (story-structure §2.9 (listicle / countdown: each item a mini-ABT))

1. chapter: The rank and the finding's name.
2. code-walk or claim-card: And: what the code does.
3. stat or claim-card: But: the cost or the surprise.
4. claim-card or code-walk: Therefore: what to take from it.

## Beats

- **hook** (open, 4-15 s): The stake or the thing in action, before any context.
- **promise** (open, 4-12 s): What the video will show, as the chapters ahead.
- **context-map** (explain, 8-20 s): The system as one box among its users and neighbours.
- **misconception** (explain, 6-18 s): What people believe, then what is true.
- **stakes** (open, 5-15 s): What it costs if this goes wrong, or what it opens if it goes right.
- **issue-pin** (evidence, 6-20 s): Problems pinned where they live on the map.
- **stat** (evidence, 4-12 s): One to four numbers that carry the point.
- **claim-card** (explain, 4-14 s): One claim, stated plainly, with its source.
- **arch-map** (explain, 10-40 s): The system's parts and how they connect; the map later beats return to.
- **code-walk** (evidence, 10-35 s): A short code excerpt with a moving focus band.
- **info-flow** (explain, 8-30 s): How data or work moves through the parts, left to right.
- **sequence** (explain, 10-35 s): Who calls whom, in order: actors, lifelines and messages.
- **compare** (evidence, 8-25 s): Two things side by side, row by row.
- **docs-vs-code** (evidence, 8-25 s): What the docs say beside what the code does.
- **zoom** (explain, 6-25 s): A push into one part of the map to show what is inside it.
- **history** (explain, 8-30 s): Dated events on a time axis with a playhead.
- **algo-trace** (explain, 12-45 s): An algorithm stepping through real state.
- **fix** (evidence, 8-25 s): The change that fixes an issue, as a small diff.
- **schema** (explain, 8-25 s): The data model: tables, keys and relations.
- **chapter** (navigate, 2-5 s): A chapter card: number, title and its question.
- **takeaways** (close, 6-18 s): What to remember, as a short list.
- **button** (close, 3-8 s): The one action to take next.
- **outro** (close, 2-6 s): The closing line.

## Rules for the plan stage

- **owner-FB2.1**: Keep a ledger of every item the video names, each with a kind and the beat that defines it, and define an item before using it.
- **owner-FB4.1**: A list holds one kind of item.
- **owner-FB6.1**: Seat each invariant in an architecture row that keeps it.
