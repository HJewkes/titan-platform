# Planner guide: pr-overview

<!-- Generated from doctrine/types/pr-overview.yaml (profile 0.2.0) by `explainer guide types`. Do not edit. -->

Explain one change: why it exists, what it changes grouped by purpose, what proves it, what it risks, and what the viewer should do.

## Audience

owner-internal: The owner and titan agents: expert in code, new to this subject. Titan-relative verdicts are on screen.

## Runtime

Aim for 2:30, within 1:30-4:00. Above 5:00, split into episodes.

## Structure

Pick the macro structure: ask these in order and stop at the first yes.

1. Is the PR waiting on the viewer at a gate? Then **scqa**.
2. Is it a bug fix with attempts that broke along the way? Then **attempt-journey**.
3. Did review take three or more rounds? Then **review-saga**.
4. None of these: **before-after**.

Block order per macro:

- **scqa**: summary → changes → proof → ask
- **attempt-journey**: summary → attempt → breaks → proof → ask
- **review-saga**: summary → rounds → changes → proof → ask
- **before-after**: summary → problem → changes → interactions → shortcomings → proof → ask

Blocks:

- **summary** (10-25 s): An imperative one-line summary that stands alone, with the verdict. Beats: verdict-card, claim-card, hook; must include verdict-card.
- **problem** (15-40 s): The problem, and why this approach. Beats: claim-card, stakes, compare.
- **changes** (30-70 s): The changes grouped into two to four rows of related files. Beats: change-group, diff-map, code-walk, frame-flow; must include change-group.
- **interactions** (15-40 s): A sequence diagram, only if interactions changed. Beats: sequence, info-flow.
- **attempt** (20-45 s): What was tried, in the code. Beats: attempt, code-walk; must include attempt.
- **breaks** (20-45 s): Where it broke and why. Beats: issue-pin, sequence, info-flow.
- **rounds** (20-50 s): The review rounds and what each one caught. Beats: history, finding-card.
- **shortcomings** (10-30 s): Shortcomings, said aloud. Beats: finding-card, fix; must include finding-card.
- **proof** (15-40 s): Tests or a benchmark that show it holds. Beats: proof, stat, compare; must include proof.
- **ask** (10-25 s): Risk or effort, then the ask. Beats: metrics-panel, button; must include button.

## Hook and ending

- Hook: Stake first: the verdict and what it costs or opens, in the first sentence.
- Ending: button

## Cuts

- **decision-brief** (0:45-1:30): The PR waits at the visual gate: verdict, one change row, proof and the ask, in BLUF order.

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

### attempt-journey

The fix told as its attempts: what was tried, where each broke and why, then what holds. (video-profiles plan §B.1 (journey of attempts); story-structure §2.5 (story spine))

Spine sections: 1. Summary; 2. Attempts; 3. Proof.

### review-saga

A change told through its review rounds: what each round caught, and the change that survived. (video-profiles plan §B.1 (review rounds as the spine))

Spine sections: 1. Summary; 2. Rounds; 3. What survived.

### before-after

The problem, the change as before against after grouped by purpose, then its proof and shortcomings. (story-structure §2.8 (problem–solution); video-profiles plan §B.1 (CL order))

Spine sections: 1. Problem; 2. Before and after; 3. Shortcomings.

## Beats

- **verdict-card** (open, 5-16 s): The bottom line first: an imperative one-line summary, the call and why.
- **claim-card** (explain, 4-14 s): One claim, stated plainly, with its source.
- **hook** (open, 4-15 s): The stake or the thing in action, before any context.
- **stakes** (open, 5-15 s): What it costs if this goes wrong, or what it opens if it goes right.
- **compare** (evidence, 8-25 s): Two things side by side, row by row.
- **change-group** (explain, 10-35 s): The changes grouped into two to four rows of related files.
- **diff-map** (explain, 10-35 s): The architecture with what the change added, removed or changed.
- **code-walk** (evidence, 10-35 s): A short code excerpt with a moving focus band.
- **frame-flow** (evidence, 8-25 s): A user flow as captured frames, in order.
- **sequence** (explain, 10-35 s): Who calls whom, in order: actors, lifelines and messages.
- **info-flow** (explain, 8-30 s): How data or work moves through the parts, left to right.
- **attempt** (explain, 6-22 s): What was tried, what happened and why.
- **issue-pin** (evidence, 6-20 s): Problems pinned where they live on the map.
- **history** (explain, 8-30 s): Dated events on a time axis with a playhead.
- **finding-card** (evidence, 6-22 s): Review findings, said aloud, with severity and status.
- **fix** (evidence, 8-25 s): The change that fixes an issue, as a small diff.
- **proof** (evidence, 6-22 s): The checks that show it holds: failing at base, passing at head.
- **stat** (evidence, 4-12 s): One to four numbers that carry the point.
- **metrics-panel** (evidence, 6-18 s): A small table: measure, today, target.
- **button** (close, 3-8 s): The one action to take next.

## Rules for the plan stage

- **owner-FB2.1**: Keep a ledger of every item the video names, each with a kind and the beat that defines it, and define an item before using it.
- **owner-FB4.1**: A list holds one kind of item.
- **owner-FB6.1**: Seat each invariant in an architecture row that keeps it.
