---
"@titan-design/explainer": minor
---

Add the listener-questions probe (TP-4080): a fresh listener hears each chapter once and lists every question it leaves unanswered, tagged by sentence. The result (`ListenerResultSchema`) counts questions per sentence and chapter, density, and flags lists spread over two or more sentences, terms used before they are set up, and fragments. It runs as an opt-in reported check on the script stage (`explainer run --listener-questions`, `--listener-threshold`, default off) and on a script file (`explainer eval listener`).
