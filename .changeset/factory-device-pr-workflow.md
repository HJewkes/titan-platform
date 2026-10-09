---
"@titan-design/factory": minor
---

Add the `device-pr` workflow (pilot 3): land-pr whose approval is a `device-confirm` gate. The owner performs the device step named by the `deviceStep` param and answers pass, fail or abandon at the exact head, from the terminal at the device. A fail reads as a red head, so the ci-failed gate decides what follows, and a new head asks the device again. The factory never talks to a device.
