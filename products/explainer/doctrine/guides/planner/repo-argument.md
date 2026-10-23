# Planner guide: repo-argument

<!-- Generated from doctrine/types/repo-argument.yaml (profile 0.1.0) by `explainer guide types`. Do not edit. -->

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

## Rules for the plan stage

- **owner-FB1**: Open on the problem, then follow one task's journey with each step's why, then show the architecture that carries it.
- **owner-FB2.1**: Keep a ledger of every item the video names, each with a kind and the beat that defines it, and define an item before using it.
- **owner-FB4.1**: A list holds one kind of item.
- **owner-FB6.1**: Seat each invariant in an architecture row that keeps it.
