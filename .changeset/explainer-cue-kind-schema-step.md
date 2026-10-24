---
"@titan-design/explainer": patch
---

The script stage now rejects a reply whose cue target names a kind outside the cue-kind table, and the schema retry names the kind and the beat. Outside the stage, the item track still throws on such a cue, so L0 fails its pace rows. The L0 repair no longer carries an item-track hint, since no reply that reaches it can hold an unknown kind.
