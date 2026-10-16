---
"@titan-design/titan": patch
---

Extract the systemd unit quoting helpers and the oneshot service and calendar timer renderers from
the health sampler units into a shared `systemd/render` module, so host services can render their
units the same way. The health sampler units render byte-identical output.
