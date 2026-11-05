# Fewer Rounds by Design: A Synthetic Study of Review Convergence

Synthetic fixture text, written for tests. No real paper, team or dataset is described.

## Abstract

We model code review as a sequence of rounds, each of which passes with a fixed probability.
Across 1,200 simulated pull requests, raising the one-round pass rate from 65% to 78% cut the
mean rounds per change from 2.08 to 1.32. Teams that re-review only the diff converge faster
than teams that re-read the whole change.

## Results

**Figure 1: Mean rounds per change by one-round pass rate**

| Pass rate | Full re-read | Diff only |
|---|---|---|
| 0.65 | 2.08 | 1.71 |
| 0.70 | 1.84 | 1.52 |
| 0.78 | 1.55 | 1.32 |

Figure 2: The review loop as a state diagram

![review loop](figure-2.png)

Table 1: Reviewer roles

| Role | Duty |
|---|---|
| Author | Opens the change |
| Reviewer | Reads the diff |

**Table 2: Changes by risk tier**

| Tier | Changes |
|---|---|
| Low | 640 |
| Medium | 410 |
| High | 150 |

## Limits

The model ignores reviewer fatigue and assumes rounds are independent, which real reviews are not.
