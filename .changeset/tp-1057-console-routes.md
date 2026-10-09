---
"titan-console": patch
---

Cut the rail to six (Home, Work, Tasks, Sessions, Agents, Knowledge) and add entity routes: `#/tasks/<id>`, `#/sessions/<id>`, `#/agents/<name>` and `#/knowledge/<ref>` round-trip with their query string kept, and a knowledge ref encodes as one segment. Add `refToRoute` for the seven ref classes, `initiativeForTask` for a task id's prefix, and a page registry in `src/pages/index.ts`.
