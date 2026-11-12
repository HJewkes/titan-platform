# seat-spec

**Tier 0 · primitives.** Peer dependency: `zod`.

```sh
npm install @titan-design/seat-spec
```

## The problem it solves

A standing coordinator seat should launch with the same profile, account, permission mode,
surface and depth however it is started. Before this package, a seat revived by another agent
took whatever that agent chose, and a teleport carried the choice forward. There was no
definition the owner held that every launch path had to load.

This package is that definition and the pure rules around it:

- `seatSchema` is the `titan-seat/v1` file: closed enums, strict objects, no defaults for a
  required field.
- `parseSeat(text, expectedName)` refuses an unknown field, a missing field, a bypass
  permission mode, a headless surface or a name that differs from the file's, each with a
  named code.
- `checkOwnerFile(path, facts, context)` applies the seat-policy fail-closed rules to `lstat`
  facts: a regular file, not a symlink, owned by the owner, not group- or world-writable,
  directly inside an owner-held seats directory that no agent-writable root overlaps.
- `loadSeat(input)` runs every check in order over what a reader saw: the seat file, the
  seat index (`titan-seat-index/v1`) and the pinned prompt, whose sha256 must match. It
  returns the seat and the file's own sha256 for the launch log.
- `resolveLaunch(seat, request)` builds the launch from the definition alone and lists the
  requester fields it overrode.

## When to reach for it

Use it in any launcher that starts a named seat: spawn, resume, teleport, a watchdog relaunch,
a host launcher or the owner's own start command. Read the files in the launcher, pass the
facts and bytes in, and refuse the launch with `seat_definition_unloadable: <code>` on any
refusal. For an autonomy coordinator's `autonomy-seat/v1` front matter, use
[coordinator](./coordinator.md).

## Example

Verified against 0.0.0.

```ts
import fs from "node:fs";
import { loadSeat, resolveLaunch, SEAT_FILE_SUFFIX, type OwnerFileRead } from "@titan-design/seat-spec";

const read = (file: string): OwnerFileRead => {
  try {
    return { path: file, facts: fs.lstatSync(file), content: fs.readFileSync(file) };
  } catch (err) {
    return { path: file, error: String(err) };
  }
};

const loaded = loadSeat({
  name: "example-steward",
  seat: read(`${seatsDir}/example-steward${SEAT_FILE_SUFFIX}`),
  index: read(`${seatsDir}/index.json`),
  prompt: read(`${seatsDir}/example-steward.prompt.md`),
  context: { ownerUid, seatsDir, seatsDirFacts: fs.lstatSync(seatsDir), agentWritableRoots },
});
if (!loaded.ok) throw new Error(`seat_definition_unloadable: ${loaded.refusal.code}`);
const resolved = resolveLaunch(loaded.seat, { seat: "example-steward", profile: "whatever-the-requester-chose" });
```

## What it deliberately does not do

- It reads no file, process or environment. A launcher reads the files and passes the facts in,
  so every check runs on synthetic stat results in tests.
- It holds no lease. Single-instance enforcement belongs to the launcher.
- It does not check that the profile named by the seat exists or has drifted; the launcher
  owns its profile store.

## Gotchas

- Refusals are returned, not thrown. A file the reader could not open is `unreadable`, never
  "no seat".
- A seat the index's `seats` list does not name is refused (`not_in_index`), so removing a seat
  from the index stops it loading.
- `ownerOnlyRead` is honoured only for the single seat the index lists in `ownerOnlyReaders`;
  an index naming two, or naming a seat outside `seats`, is refused.
- Every `agentWritableRoots` entry must be absolute; pass realpath output, since the overlap
  compare is case-sensitive.
- `resolveLaunch` gives a root seat depth 0 and any other seat depth 1, whatever the
  requester's own depth.
- `seatHash` is the sha256 of the exact bytes passed in; pass the bytes, not a re-serialised
  object.

## Where it came from

New, for TP-5459: the seat definition every launch path loads. The agent-chat broker is its
first enforcer.
