---
"@titan-design/explainer": patch
---

Render no longer template-fills a beat that resolve made custom. It shares `isCustomRow` with resolve's template-fill gate, holds the beat on the board by spec type with no slots, and draws its built custom layer. A custom beat with no built layer fails the stage naming the beat, instead of falling back to a list or a template-fill refusal.
