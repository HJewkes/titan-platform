---
"@titan-design/explainer": patch
---

Excuse camera jerk and velocity spikes whose finite-difference window overlaps a declared shake window. A jump on a shake's last sample no longer reports a `camera:jerk` time after the shake ends.
