---
"@titan-design/explainer": minor
---

Add `explainer eval calibrate` and its core: LabelsSchema reads a labels/v1 labelled set (v4's ships as a fixture), and calibrate scores structure rows against it, giving precision and recall per check with borderline labels counted as neither, plus recall on the owner-named beats over error-severity rows (TP-2985).
