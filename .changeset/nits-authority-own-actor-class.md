---
"@titan-design/authority": patch
---

`evaluate` reads the actor class only from an own property, so a polluted `Object.prototype.class` can no longer supply one.
