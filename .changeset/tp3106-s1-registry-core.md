---
"@titan-design/factory": patch
"@titan-design/review-panel": patch
---

TP-3106 S1: the factory gains a step registry core (`src/registry/`) and the pin-class rule file. `pin-classes.ts` is the only place a fact's pin class is set; an entry names its fact, never its class, and `createRegistry` refuses an unknown fact, a reused name, a missing kind, an effect without a target and reason, and a declared `pinClass`. `schemaHash` hashes a fact entry's input and output JSON Schemas. The marker store now imports `PinClass` from the rule file. In review-panel, `pin-classes.ts` joins the `authority` globs, so a pin-class change takes the adversarial class.
