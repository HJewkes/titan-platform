# Item vc-65 rewritten under the AskUserQuestion contract

[vc-65.1] **Recommend the strict rule** (two-way). VW-343 adds a left/right asymmetry tint to the body map figure. When may a muscle be tinted? Strict: the same side tested stronger in 3 or more tests, the latest test is outside measurement spread, and the latest test agrees. Loose: the same side tested stronger in 3 or more tests, and nothing else. Now: none, no tint exists.

[vc-65.2] **Recommend no** (two-way). Should the asymmetry tint from VW-343 (the body map left/right tint) get stronger as the gap between sides grows? No: the fill only says which side is stronger, and the percent is text in the chip, because one test's size is not a trustworthy signal. Yes: the fill strength scales with the percent. Now: none.

[vc-65.3] **Recommend blue** (two-way, taste). Hue of the asymmetry tint from VW-343 (the body map left/right tint). Blue: the status-info token, #78C2FF in dark mode and #1072CB in light, with stronger-versus-weaker contrast 3.29 dark and 3.21 light. Grey: the result-neutral token at two strengths, contrast 3.45 dark and 3.30 light, which reads as muted. Now: both sides draw in grey result-neutral with no tint.

[vc-65.4] **Recommend the stronger side** (two-way, taste). Which side of a tinted muscle gets the full fill in VW-343 (the body map left/right tint)? Stronger side: it is filled and the weaker side is lighter and outlined, which reads as "more". Weaker side: it is filled, which reads as a deficit to fix, and the tool's guidance argues against that. Now: none.

[vc-65.5] **Principle: recommend yes** (two-way). For a new titan component, the planner settles code structure and slice order itself when the choice changes nothing you see, and lists it in the digest. It covers two choices in VW-343 (the body map left/right tint). (a) Build the tint as a new sibling component, MuscleAsymmetryFigure, and not as a prop on BodyMap, so BodyMap's fill keeps one meaning. (b) Show it first on the #/body muscle sheet, after titan-design PR #324 (the ring chip for VW-741) merges, because both edit BodyMapDetailPanel.tsx. Now: each such choice comes to you as a plan question.
