---
"@titan-design/factory": patch
---

Burn down typed-lint hits in Shepherd's tests (TP-2176): test fakes use `partialFake` and `fakeLocator`, and malformed-input probes set their bad field with `Object.assign`, in place of casts.
