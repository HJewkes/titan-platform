---
{
  "schema": "autonomy-seat/v1",
  "name": "seat-b",
  "prefix": "pb",
  "role": "product",
  "attended": false,
  "profile": "profile-a",
  "surface": "surface-a",
  "model": "model-a",
  "effort": "high",
  "pool": "pool-c",
  "config_dir": "/home/user/cfg/pool-c",
  "cwd": "/home/user/work/dir-b",
  "heartbeat_cron": "19,49 * * * *",
  "initiatives": {
    "init-a": 1.0,
    "init-b": 0.7,
    "init-c": 0.8,
    "init-d": 0.8
  },
  "scope_tags": [
    "scope-a",
    "scope-b"
  ],
  "unclaimed_engineering": false,
  "task_sources": [
    "source-a",
    {
      "pm_dir": "/home/user/work/pm",
      "initiative": "init-a",
      "projects": [
        "PRJ1",
        "PRJ2",
        "PRJ3",
        "PRJ4",
        "PRJ5",
        "PRJ6"
      ],
      "exclude_projects": [
        "PRJX"
      ]
    }
  ],
  "repos": [
    {
      "path": "~/work/repo-6",
      "remote": "org-a/repo-6",
      "default": "main",
      "initiatives": [
        "init-a"
      ]
    },
    {
      "path": "~/work/repo-7",
      "remote": "org-a/repo-7",
      "default": "main",
      "initiatives": [
        "init-a"
      ],
      "public": true
    },
    {
      "path": "~/work/repo-8",
      "remote": "org-a/repo-8",
      "default": "main",
      "initiatives": [
        "init-a"
      ],
      "confidential": true
    },
    {
      "path": "~/work/repo-9",
      "remote": "org-a/repo-9",
      "default": "main",
      "initiatives": [
        "init-a"
      ],
      "public": true
    },
    {
      "path": "~/work/repo-10",
      "remote": "org-a/repo-10",
      "default": "main",
      "initiatives": [
        "init-a"
      ],
      "shared_with": [
        "seat-a"
      ]
    },
    {
      "path": "~/work/repo-11",
      "default": "main",
      "initiatives": [
        "init-a"
      ],
      "local_only": true
    },
    {
      "path": "~/work/repo-12",
      "initiatives": [
        "init-a"
      ]
    },
    {
      "path": "~/work/repo-13",
      "default": "master",
      "initiatives": [
        "init-a"
      ],
      "local_only": true
    },
    {
      "path": "~/work/repo-1",
      "default": "main",
      "initiatives": [
        "init-a"
      ],
      "shared_with": [
        "seat-a"
      ],
      "overflow_until": "2026-10-09"
    },
    {
      "path": "~/work/repo-2",
      "default": "main",
      "initiatives": [
        "init-a"
      ],
      "shared_with": [
        "seat-a"
      ],
      "overflow_until": "2026-10-09"
    },
    {
      "path": "~/work/repo-3",
      "default": "main",
      "initiatives": [
        "init-a"
      ],
      "shared_with": [
        "seat-a",
        "seat-b"
      ],
      "overflow_until": "2026-10-09"
    }
  ],
  "deny_repos": [
    "~/work/repo-14"
  ],
  "kind_weights": {},
  "share_caps": {},
  "spend": {
    "per_run_points": 100,
    "per_day_points": 100
  },
  "concurrency": {
    "implementers": 2,
    "reviewers": 2,
    "planners": 1
  },
  "excluded_tags": [
    "tag-a",
    "tag-b",
    "tag-c",
    "tag-d",
    "tag-e",
    "tag-f",
    "tag-g",
    "tag-h"
  ],
  "excluded_title_patterns": [
    "pattern-a",
    "pattern-b",
    "pattern-c",
    "pattern-d",
    "pattern-e",
    "pattern-f",
    "pattern-g",
    "pattern-h",
    "pattern-i",
    "pattern-j",
    "pattern-k"
  ],
  "extra_hard_stops": [
    "stop-a",
    "stop-b",
    "stop-c",
    "stop-d",
    "stop-e",
    "stop-f",
    "stop-g"
  ],
  "grants_extra": [
    "grant-a",
    "grant-b"
  ],
  "log": "logs/seat-b/",
  "queue": "queues/seat-b.md",
  "dispatch_log": "logs/seat-b/dispatch.jsonl",
  "digest_to": "digest-a"
}
---

# seat-b

Example unattended seat.
