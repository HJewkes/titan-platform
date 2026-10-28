---
"titan-console": patch
---

The twin capture now fails on a Google Fonts request, as it does on any other request off disk (TP-3641). react-ui ships its web fonts and the build inlines them, so the twin no longer lets that request fail quietly. The README's twin table says which text still falls back to the system sans.
