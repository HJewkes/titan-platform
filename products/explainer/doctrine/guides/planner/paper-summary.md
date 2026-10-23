# Planner guide: paper-summary

<!-- Generated from doctrine/types/paper-summary.yaml (profile 0.1.0) by `explainer guide types`. Do not edit. -->

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
- **anomaly** (15-40 s): The number that should not be true. Beats: hook, stat.
- **method** (40-90 s): How it was shown, as a diagram. Beats: info-flow, schema, sequence.
- **twist** (30-60 s): The unexpected angle. Beats: compare, algo-trace.
- **result** (30-70 s): The result with its interval and grade. Beats: stat, chart, compare.
- **limits** (15-40 s): How far to trust it. Beats: claim-card, list.
- **so-for-us** (20-50 s): What it changes for us, then the button. Beats: takeaways, compare, button; must include button.

## Hook and ending

- Hook: Open on the concrete example or the number, never on the paper's title.
- Ending: takeaways+button

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
