---
{
  "schema": "autonomy-charter/v1",
  "title": "Autonomy charter (generic; every seat runs this plus its seat file)",
  "created": "2026-01-01",
  "owner_seat": "seat-a",
  "supersedes": "../notes/old-charter.md",
  "design": "../plan.md",
  "retro": "../notes/retro.md",
  "root": "/home/user/autonomy",
  "seats": [
    "seat-a",
    "seat-b"
  ],
  "hub": "seat-a",
  "charter_owner": "seat-a",
  "human_only_initiatives": [
    "init-x",
    "init-y",
    "init-z"
  ],
  "hard_stops": [
    "ruleset-write",
    "tag-move",
    "npm-publish",
    "broker-restart",
    "launchd-install",
    "dotfiles-merge",
    "config-edit",
    "force-push",
    "deploy",
    "spend-money",
    "third-party-message",
    "personal-data"
  ],
  "defaults": {
    "kind_weights": {
      "security": 1.0,
      "product": 1.0,
      "correctness": 0.9,
      "platform": 0.8,
      "agent-tooling": 0.6,
      "docs": 0.5,
      "nit": 0.35
    },
    "share_caps": {
      "agent-tooling": 0.3,
      "nit": 0.2,
      "discovery": 0.25
    },
    "initiative_decay": 0.85,
    "score_terms": {
      "severity": 0.4,
      "priority_pct": 0.3,
      "unblocks": 0.2,
      "staleness": 0.1
    },
    "severity": {
      "critical": 1.0,
      "high": 0.7,
      "medium": 0.4,
      "low": 0.15,
      "unset": 0.3
    },
    "readiness": {
      "ready": 1.0,
      "untriaged": 0.6,
      "blocked": 0.25
    },
    "size": {
      "le3": 1.0,
      "le8": 0.9,
      "gt8": 0.75
    },
    "stop_short_factor": 0.8,
    "gate_free_bonus": 1.15,
    "retire_k": {
      "implementer": 200,
      "reviewer": 300,
      "planner": 250
    },
    "teleport_k": 250,
    "worktrees_per_repo_per_seat": 12,
    "worktrees_left_free_per_repo": 2,
    "stale_pr_days": 7,
    "heartbeat_cron": "17,47 * * * *"
  }
}
---

# Example charter

Generic policy every example seat runs.
