---
"@titan-design/factory": patch
---

Reviewer-independence lineage reads a roster row whose spawner is its own name, as each teleport generation of a seat
records, as the same seat rather than a loop, so a reviewer spawned by a teleported seat can be proven independent. A
loop through other names and a row with no stored lineage are still refused (TP-4130).
