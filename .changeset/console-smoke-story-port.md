---
"titan-console": patch
---

Self-update's smoke build runs with the story origin off (`TITAN_CONSOLE_STORY_PORT=0`). It inherited the default story port 7501, which the served console already holds, so the bind failed and every smoke reported that `/health` answered with nothing.
