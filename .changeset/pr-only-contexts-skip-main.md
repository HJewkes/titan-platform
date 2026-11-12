---
"@titan-design/factory": patch
---

Shepherd no longer judges main by the required contexts that `.github/required-checks.json` lists under `prContexts`. These are checks that only pull requests run, such as `fix-proof-mutants`. Before this change, main could never read green once such a check became required. The main CI watch then never queued a redeploy, and every land waiting on `attest-deploy-skew` waited forever (TP-5485).
