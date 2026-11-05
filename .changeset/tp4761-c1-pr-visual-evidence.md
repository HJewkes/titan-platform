---
"@titan-design/factory": minor
---

Add `ghPrVisualEvidence`, which reads a titan-design PR's `pr-visual-<head>` artifact as evidence only: per-shot changed pixels and the selected stories with no before and after pair at some width (`missing`). The read is bounded (bytes, entries, shots, pixels, zip64 refused), checks the run head and the configured workflow, and no tier, merge guard or policy module imports it, so it never lowers the visual tier.
