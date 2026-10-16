---
"@titan-design/review-panel": minor
---

`reviewerBrief` takes an optional `sourceCheckout`. When it is set, the brief fetches and archives the head with `git -C "<sourceCheckout>"`, names the run dir as the reviewer's starting directory, forbids probes against the checkout, and removes only the head, base and probe dirs rather than the run dir itself. A `sourceCheckout` that is not an absolute path, or that holds a quote, `$`, backtick, backslash or control character, is refused with an error. Briefs without it render unchanged.
