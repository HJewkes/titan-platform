---
"@titan-design/factory": patch
---

Shepherd's registration hold follows review policy 458's sign-off classes, given by the new pure `requiredSignoffs`. One correctness sign-off is the default. Size, a migration, a security kind with no sensitive path, and unread line counts no longer place a `g10-review` hold; they still pick the g10 (Opus) correctness reviewer. Only an adversarial path (authority, policy or security) places `g10-adversary`. That list now also covers the console's owner-tap and inbox actions, gate resolution, owner release and agent-chat's agent profiles. A hold placed by hand is unchanged, and so is the fail-closed `g10-adversary` hold for an unread file list.
