---
"@titan-design/factory": patch
---

The digest's stale-gate alarm probes `digest.consoleOrigin` once, with an https GET that must answer 200 or 401 (the `titan-console link gate` rule), before it links any gate (TP-5279). A console that does not answer leaves the gate refs without links and adds one gap line saying why. A digest with no alarm makes no request.
