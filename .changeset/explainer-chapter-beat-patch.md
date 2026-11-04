---
"@titan-design/explainer": patch
---

A chunked chapter's repair round now asks back only the beats its failing rows name, keyed by beat id, and splices them into the chapter in place; the chapter's rules run again on the spliced chapter. A reply naming any other set of beats is rejected and retried once in the same round. A round whose row names the chapter rather than a beat still asks back the whole chapter. Rounds, beats and checks are unchanged, and so is the single-call path.
