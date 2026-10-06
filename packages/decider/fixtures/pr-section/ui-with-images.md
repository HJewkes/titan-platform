### example-ui#42 UI-7: Card separators move onto the hairline token

https://github.com/example/example-ui/pull/42 · head c0ffee1 (reviewed at c0ffee1) · +18/-12 in 3 files · CI green at head · open 1 d

**Recommendation: merge.** Door type: two-way (a token swap, reverted in one commit).

#### What it does
Card separators draw a 1px border in a hard-coded grey today, so they drift from the hairline token every other divider uses. After this PR, both card stories read the hairline token. Nothing else in the card changes.

#### Why it reaches you
Deliberate: Gate 2 visual sign-off, rule `shepherd-seat/design-coord`, because the PR changes rendered stories.

#### Pros
- Separators match every other divider in light and dark themes.

#### Cons
- The separator is a shade lighter in the dark theme, which a screenshot test may flag.

#### Before and after
| Story / width | Before (base 1a2b3c4) | After (head c0ffee1) |
|---|---|---|
| card--default / 1280 | ![](img/pr-42/before/card--default-1280.png) | ![](img/pr-42/after/card--default-1280.png) |
| card--dense / 1280 | ![](img/pr-42/before/card--dense-1280.png) | ![](img/pr-42/after/card--dense-1280.png) |

#### If you say yes / If you say no
Yes: Shepherd merges at c0ffee1. No: the seat closes the PR and UI-7 returns to the queue with your note.
