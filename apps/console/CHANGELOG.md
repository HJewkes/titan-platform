# titan-console

## 0.1.1

### Patch Changes

- Updated dependencies [a20a6e3]
- Updated dependencies [0e67551]
  - @titan-design/daemon@0.4.0
  - @titan-design/react-app@0.1.1
  - @titan-design/rpc-client@0.2.0

## 0.1.0

### Minor Changes

- bb898b7: Add the Initiatives view: `#/initiatives` shows the active-work portfolio with open-task rollups, note, source and session counts and newest activity, and `#/initiatives/<slug>` shows one initiative's brief, open loops, open tasks, recent sessions, notes and sources. The daemon gains `work.portfolio` and `work.initiative`, which read the active-work daemon over loopback. Personal initiatives are flagged in the console and left out of the exported page.
- d87df0d: Add the console skeleton: a react-ui app shell with hash routes and a nav for every planned view, served by one loopback daemon on port 7500 whose `upstreams.health` command reports whether the active-work daemon, the agent-chat broker and the session graph can be reached.

### Patch Changes

- Updated dependencies [9172151]
- Updated dependencies [b62813c]
- Updated dependencies [3a4d4ed]
  - @titan-design/chat-protocol@0.2.0
  - @titan-design/daemon@0.3.3
  - @titan-design/react-app@0.1.1
  - @titan-design/rpc-client@0.2.0
