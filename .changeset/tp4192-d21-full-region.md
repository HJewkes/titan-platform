---
"@titan-design/factory": patch
---

On a `ci-policy-weakened` gate, the merge evidence step now reads each changed `.github/` file (the first 10) at the base and the head, and stores every changed line of a positional diff on the evidence record as `ciPolicyChanges`. No line is chosen by what it says. Each line is either shown or counted in `omitted`: 20 per file, 120 per card, 160 characters per line. Lines split at CR, LF and CRLF only. NEL and U+2028/U+2029 become a visible mark, and escape, control, bidi and zero-width characters are stripped. A failed read is named in the gate's reason; the gate itself does not change.
