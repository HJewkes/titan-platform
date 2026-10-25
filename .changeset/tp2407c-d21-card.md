---
"@titan-design/factory": patch
---

The `ci-policy-weakened` approve-merge gate is now the D21 card: its prompt and summary name Class D21 and the weakened CI-policy keys, and the prompt lists the before→after lines of those keys in each changed `.github/` file. The merge evidence step reads those files at the base and the head only on a weakened line, through the new pure `ciPolicyChanges` helper, which strips escape and control characters, cuts each line at 160 characters and caps each file at 20 lines. A failed read is named in the gate's reason; the gate still opens.
