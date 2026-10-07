### example-ui#43 UI-8: Card story gains a loading state

https://github.com/example/example-ui/pull/43 · head d00d1e2 (reviewed at d00d1e2) · +40/-2 in 2 files · CI green at head · open 1 d

**Recommendation: merge.** Door type: two-way (a new story, removed in one commit).

#### What it does
The card had no loading state, so screens built on it showed an empty box while data arrived. After this PR, the card renders a skeleton until its content is ready. The new card--loading story shows it.

#### Why it reaches you
Deliberate: Gate 2 visual sign-off, rule `shepherd-seat/design-coord`, because the PR adds a rendered story.

#### Pros
- Screens on slow networks show a skeleton instead of an empty box.

#### Cons
- The skeleton adds one animation that runs until the content loads.

#### Before and after
No images: card--loading is a new story, so there is no before, and the pr-visual job for d00d1e2 timed out before capturing the after image.

#### If you say yes / If you say no
Yes: Shepherd merges at d00d1e2. No: the seat closes the PR and UI-8 returns to the queue with your note.
