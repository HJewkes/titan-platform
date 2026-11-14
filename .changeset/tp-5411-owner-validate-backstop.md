---
"@titan-design/factory": patch
"@titan-design/coordinator": patch
---

Add the `owner-validate` merge guard row and the `shepherd task-approval check <initiative>/<ID>` verb (TP-5411, gate model S8b). A task tagged `owner-validate` is dispatchable, and its PRs merge, only under the owner's console task approval of its current done_when; a task that cannot be read from active-work is refused too. The check exits 0 when the task may be dispatched and 3 with `no-approval`, `done-when-changed` or `task-unread` otherwise. The live switch `shepherd.gateReset.ownerValidate` (off, shadow, on; absent means shadow) is a new editable factory row; under shadow the merge evidence records the would-gate and no outcome changes.
