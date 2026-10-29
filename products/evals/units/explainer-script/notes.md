# explainer-script notes

<!-- aa-floor:start -->
## A/A noise floor (script, stage version x4)

Measured 2026-10-23 by `explainer aa-floor`: the champion against itself, 3 samples per arm over 2 cases (fixture-v4, recent-02); 14 runs, 2 failed, $14.65.
σ is one sample's noise per row, pooled over cases and arms. `explainer ab` calls a difference within 2σ noise.

The 2 failed runs made no script: the model added a key script/v1 rejects, `cues` on recent-02 sample 2 and `chips` on fixture-v4 sample 4, and the schema retry failed too. Each was rerun once at the same commit and made a script, so σ covers all 12 samples.

| row | σ (one sample) | 2σ band | A/A diff | A/A verdict |
|---|---|---|---|---|
| register:numbers | 8.502 | ± 17.004 | +4.656 | noise |
| register:numbers-per-beat | 0.087 | ± 0.174 | +0.051 | noise |
| register:triads | 1.484 | ± 2.968 | -1.028 | noise |
| register:sentence-mean | 0.390 | ± 0.780 | -0.222 | noise |
| register:sentence-cv | 0.033 | ± 0.066 | -0.003 | noise |
<!-- aa-floor:end -->
