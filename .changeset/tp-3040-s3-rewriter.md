---
"@titan-design/speech-vet": minor
---

TP-3040 S3: speech-vet exports the pronounceable-text rewriter. `rewriteLine` replaces only the sentence holding a `needs-rewrite` span: a pinned sentence resolves from `RewritePins` with no candidate asked, a pinned rewrite is refused, and each candidate from the `symbolRules` rule tier or an injected `CandidateSource` passes `guardRewrite` and must re-vet `accepted` before it is pinned. Also exports `guardRewrite`, `contentTerms`, `RewritePins`, `RewritePinsSchema`, `pinKey`, `applyPins`, `UnpinnedRewriteError` and `SYMBOL_WORDS`.
