---
"@titan-design/factory": patch
---

Shepherd no longer lands a stale green whose moved base shares a unit with the PR. On a repo without strict up-to-date rules, a green head behind main now lands as it stands only when main's delta touches no `packages/*`, `products/*` or `apps/*` unit the PR changed, and no root build config. Otherwise land merges main in through update-branch, under the update bound, and the required checks run on that merge. `land` takes the new `recheckMovedBase` option for this.
