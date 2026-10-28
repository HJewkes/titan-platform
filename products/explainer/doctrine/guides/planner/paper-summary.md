# Planner guide: paper-summary

<!-- Generated from doctrine/types/paper-summary.yaml (profile 0.3.1) by `explainer guide types`. Do not edit. -->

One finding: a concrete example, the key idea, how it was shown, how far to trust it, and what it changes for us.

## Audience

owner-internal: The owner and titan agents: expert in code, new to this subject. Titan-relative verdicts are on screen.

## Runtime

Aim for 5:00, within 4:00-8:00. Above 10:00, split into episodes.

## Structure

Pick the macro structure: ask these in order and stop at the first yes.

1. Does the paper bear on a change we are deciding (should we change X)? Then **scqa**.
2. Is there a number that should not be true, which a model can rebuild? Then **mystery**.
3. Is the headline an elegant algorithm? Then **kishotenketsu**.
4. None of these: **lab-report**.

Block order per macro:

- **lab-report**: example → key-idea → method → result → limits → so-for-us
- **scqa**: example → situation → complication → answer → limits → so-for-us
- **mystery**: anomaly → method → result → limits → so-for-us
- **kishotenketsu**: example → key-idea → twist → result → so-for-us

Blocks:

- **example** (20-50 s): One concrete example before any generality. Beats: hook, user-flow, stat.
- **key-idea** (20-50 s): The one key idea. Beats: claim-card, info-flow.
- **situation** (15-40 s): Where they stand, in one number. Beats: stat, claim-card.
- **complication** (15-40 s): Where we stand against it. Beats: compare, stat.
- **answer** (20-50 s): The change that closes the gap, by 25% of runtime. Beats: claim-card, compare.
- **anomaly** (15-40 s): The number that should not be true. Beats: hook, stat, sim.
- **method** (40-90 s): How it was shown, as a diagram. Beats: info-flow, schema, sequence, sim.
- **twist** (30-60 s): The unexpected angle. Beats: sim, compare, algo-trace.
- **result** (30-70 s): The result with its interval and grade. Beats: replot, stat, compare.
- **limits** (15-40 s): How far to trust it. Beats: claim-card, list.
- **so-for-us** (20-50 s): What it changes for us, then the button. Beats: takeaways, rule-diff, compare, button; must include button.

## Hook and ending

- Hook: Open on the concrete example or the number, never on the paper's title.
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

Beat systems: **example-first** over every block.

### mystery

Cold open on an anomaly, follow the clues and false leads, then reveal the cause. (story-structure §2.10 (mystery / open loop), §4 row 2)

Spine sections: 1. Anomaly; 2. Clues and false leads; 3. Reveal; 4. Open loops.

Beat systems: **lab-cycle** over every block.

### kishotenketsu

Introduce, develop, twist with an unexpected angle, reconcile: an elegant idea with no conflict. (story-structure §2.4 (kishōtenketsu), §4 row 5)

Spine sections: 1. Idea; 2. Development; 3. Twist; 4. Reconciliation.

Beat systems: **lab-cycle** over every block.

### lab-report

A concrete example, the key idea, how it was shown, the result with its limits, and what it changes for us. (video-profiles plan §B.2 (example before generality))

Spine sections: 1. Example; 2. Key idea; 3. Method and result; 4. So for us.

Beat systems: **example-first** over every block.

## Beat systems

A beat system is the beat order inside a structure's blocks, not a structure of its own. Play the steps in order; a step lands in the same block as the one before it or a later one, and an optional step may be dropped.

### example-first

A concrete example before any generality, then the key idea, how it was shown, the result, its limits, and what it changes for us. (video-profiles plan §B.2 (example before generality) [W46, W18])

1. hook or user-flow or stat: One concrete example, before any general statement.
2. claim-card: The one key idea the example shows.
3. info-flow or schema or sequence or sim (optional): How it was shown, as a diagram the pointer follows.
4. replot or stat or compare: The result, with its interval and grade.
5. claim-card or list: Its limits: how far to trust it.
6. takeaways or rule-diff or compare: So for us: what it changes here.
7. button: The button.

### lab-cycle

A question, a model run live to answer it, the reading, and what it means. (video-profiles plan §B.2 and §B.3 (a lab cycle with a sim))

1. chapter-open or hook or claim-card: The question, or the number that should not be true.
2. sim: The model, run live: the viewer watches the claim happen.
3. replot or stat or compare (optional): The reading, on the same axes as the source.
4. verdict-chip or claim-card or takeaways: What it means.

## Beats

- **hook** (open, 4-15 s): The stake or the thing in action, before any context.
- **user-flow** (explain, 8-25 s): One user's path through the thing, step by step.
- **stat** (evidence, 4-12 s): One to four numbers that carry the point.
- **claim-card** (explain, 4-14 s): One claim, stated plainly, with its source.
- **info-flow** (explain, 8-30 s): How data or work moves through the parts, left to right.
- **compare** (evidence, 8-25 s): Two things side by side, row by row.
- **sim** (evidence, 12-45 s): A small model we run, sweeping one parameter.
- **schema** (explain, 8-25 s): The data model: tables, keys and relations.
- **sequence** (explain, 10-35 s): Who calls whom, in order: actors, lifelines and messages.
- **algo-trace** (explain, 12-45 s): An algorithm stepping through real state.
- **replot** (evidence, 8-25 s): A figure from a source, re-plotted from its data.
- **list** (explain, 5-18 s): Up to five marked rows: tick, cross, risk, open or dot.
- **takeaways** (close, 6-18 s): What to remember, as a short list.
- **rule-diff** (close, 6-18 s): The change to one of our rules a finding implies.
- **button** (close, 3-8 s): The one action to take next.

## Rules for the plan stage

- **owner-FB2.1**: Keep a ledger of every item the video names, each with a kind and the beat that defines it, and define an item before using it.
- **owner-FB4.1**: A list holds one kind of item.
- **owner-FB6.1**: Seat each invariant in an architecture row that keeps it.
- **talks-ST11**: Plan each visual beat's headline first, as a short claim the picture proves: who or what does something, never a topic label. Write the narration after it, to back that claim.
