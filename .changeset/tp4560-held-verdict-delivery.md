---
"@titan-design/factory": patch
---

When no fixer can start on a FIX_FIRST send-back, Shepherd now posts the reviewer's findings as one PR comment, marked per head so a repeat refusal finds it rather than posting again, and puts them in the seat's notice. Before this they lived only in the reviewer's transcript (TP-4560).
