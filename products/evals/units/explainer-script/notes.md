# explainer-script notes

<!-- aa-floor:start -->
## A/A noise floor (script, stage version x4)

Measured 2026-10-23 by `explainer aa-floor`: the champion against itself, 3 samples per arm over 2 cases (fixture-v4, recent-02); 12 runs, 2 failed, $12.26.
σ is one sample's noise per row, pooled over cases and arms. `explainer ab` calls a difference within 2σ noise.

| row | σ (one sample) | 2σ band | A/A diff | A/A verdict |
|---|---|---|---|---|
| register:numbers | 6.906 | ± 13.811 | +8.685 | noise |
| register:numbers-per-beat | 0.057 | ± 0.114 | +0.092 | noise |
| register:triads | 1.153 | ± 2.307 | -0.265 | noise |
| register:sentence-mean | 0.389 | ± 0.778 | -0.263 | noise |
| register:sentence-cv | 0.035 | ± 0.070 | +0.003 | noise |
<!-- aa-floor:end -->
