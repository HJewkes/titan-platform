# Planner guide: pr-overview

<!-- Generated from doctrine/types/pr-overview.yaml (profile 0.1.0) by `explainer guide types`. Do not edit. -->

Explain one change: why it exists, what it changes grouped by purpose, what proves it, what it risks, and what the viewer should do.

## Audience

owner-internal: The owner and titan agents: expert in code, new to this subject. Titan-relative verdicts are on screen.

## Runtime

Aim for 2:30, within 1:30-4:00. Above 5:00, split into episodes.

## Structure

Pick the macro structure: ask these in order and stop at the first yes.

1. Is the PR waiting on the viewer at a gate? Then **scqa**.
2. Is it a bug fix with attempts that broke along the way? Then **journey**.
3. Did review take three or more rounds? Then **review-saga**.
4. None of these: **before-after**.

Block order per macro:

- **scqa**: summary → changes → proof → ask
- **journey**: summary → attempt → breaks → proof → ask
- **review-saga**: summary → rounds → changes → proof → ask
- **before-after**: summary → problem → changes → interactions → shortcomings → proof → ask

Blocks:

- **summary** (10-25 s): An imperative one-line summary that stands alone, with the verdict. Beats: claim-card, verdict-chip, hook; must include claim-card.
- **problem** (15-40 s): The problem, and why this approach. Beats: claim-card, stakes, compare.
- **changes** (30-70 s): The changes grouped into two to four rows of related files. Beats: arch-map, code-walk, list.
- **interactions** (15-40 s): A sequence diagram, only if interactions changed. Beats: sequence, info-flow.
- **attempt** (20-45 s): What was tried, in the code. Beats: code-walk, history.
- **breaks** (20-45 s): Where it broke and why. Beats: issue-pin, sequence, info-flow.
- **rounds** (20-50 s): The review rounds and what each one caught. Beats: history, issue-pin.
- **shortcomings** (10-30 s): Shortcomings, said aloud. Beats: issue-pin, fix.
- **proof** (15-40 s): Tests or a benchmark that show it holds. Beats: stat, chart, compare.
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

## Rules for the plan stage

- **owner-FB1**: Open on the problem, then follow one task's journey with each step's why, then show the architecture that carries it.
- **owner-FB2.1**: Keep a ledger of every item the video names, each with a kind and the beat that defines it, and define an item before using it.
- **owner-FB4.1**: A list holds one kind of item.
- **owner-FB6.1**: Seat each invariant in an architecture row that keeps it.
