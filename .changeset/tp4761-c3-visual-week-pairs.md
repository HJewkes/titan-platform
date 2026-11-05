---
"@titan-design/factory": patch
---

`shepherd visual-week --images <dir>` now writes each batched PR's before and after screenshot pairs from its `pr-visual` artifact under `<dir>/pr-<n>/` and adds one packet section per PR with the line "pr-visual: n shots, k changed, m missing (unattested producer output; not used for the tier)". A PR with no artifact, a head mismatch, a partial shot or an unreadable zip gets a stated reason and no images, never an after-only set. The evidence informs the owner only and never changes a tier.

The CLI resolves a relative `--images` directory against its own working directory; the registry command accepts only an absolute `images` path, so an MCP caller cannot write relative to the hub's working directory.
