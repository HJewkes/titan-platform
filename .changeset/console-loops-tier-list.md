---
"titan-console": minor
---

Add the `#/loops` open-loops tier list: every loop from active-work's `loop.board` in its advisory tier (S, A, B, C, Parked) or the Unsorted tray, ordered by tier rank, with status, seat, days since motion, owner emphasis and task chips, and filters by initiative and status. A card moves by drag on a desktop or by its Move to menu anywhere, through the new owner-write `work.loop-tier` (active-work's `loop.tier`); the move shows at once and comes back out if the console refuses it. Off the owner's LAN session the tiers are read-only and the page says why. The new read `work.loops` answers `unavailable: "active-work ≥ 0.23 needed"` on a daemon that has no `loop.board`, never an empty board. The board contract is one zod schema in `server/loop-board.ts`.
