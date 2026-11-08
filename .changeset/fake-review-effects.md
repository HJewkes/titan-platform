---
"@titan-design/github": patch
---

The GitHub fake's `FakeEffects` now counts `createReview` and `dismissReview` writes, so a crash test can assert each lands at most once. A write a fault rejects before it lands is not counted. Test fake only; no gate or approval logic changes.
