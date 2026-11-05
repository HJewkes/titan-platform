---
"@titan-design/factory": patch
---

Shepherd's merge order no longer chains waits through a run still waiting for its turn (TP-4501). A reservation whose run sits in its order-wait step, with no conflict fixer at work yet, orders only other waiters, oldest reservation first, so a ready overlapping PR lands past it and two overlapping waiters never wait on each other. Once the run leaves its wait and its fixer starts, the reservation orders every overlapping PR again, as before (TP-4098).
