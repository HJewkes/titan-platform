# rpc-protocol

**Tier 0 · primitives.** No titan dependencies and no runtime dependencies at all.

```sh
npm install @titan-design/rpc-protocol
```

## The problem it solves

A daemon built on [`daemon`](/reference/daemon) and [`registry`](/reference/registry)
speaks a fixed wire: `POST /rpc/<command>` returns a JSON envelope, `/events` streams SSE
frames, `/health` and `/version` report status. That contract lived implicitly inside the
two server packages, so every front end re-typed it by hand, and a browser bundle could not
import `JsonEnvelope` from `registry` without also naming a package that peers on zod.

The primitive is **the contract as data and types**, with nothing else: envelope,
exit codes, route paths, the `/rpc` failure statuses, the SSE event names and heartbeat,
and the `CommandMap` shape a typed client is generic over.

## When to reach for it

Browser or Node code that talks to a running daemon, and server code that must answer in
the same shape. Reach for [`registry`](/reference/registry) to define and invoke commands,
and for [`daemon`](/reference/daemon) to host them; both import their wire vocabulary from
here.

## Example

Verified against 0.1.0.

```ts
import {
  EVENTS_PATH,
  RPC_PREFIX,
  SSE_EVENTS,
  type JsonEnvelope,
} from "@titan-design/rpc-protocol";

const res = await fetch(`${origin}${RPC_PREFIX}task.list`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ status: "open" }),
});
const envelope = (await res.json()) as JsonEnvelope<Task[]>;
if (!envelope.ok) throw new Error(`${envelope.error} (${envelope.code})`);

const events = new EventSource(`${origin}${EVENTS_PATH}`);
events.addEventListener("change", refetch);
events.addEventListener(SSE_EVENTS.READY, () => setLive(true));
```

## What it deliberately does not do

It makes no requests. The typed client with live and static data sources is
`rpc-client` (TP-139). It carries no runtime validation, so there is no zod; commands
validate their own args in `registry`. It does not describe the `/health` payload, the
request guards' 403 and 415 refusals, or `/mcp`; those stay with `daemon`. It does not yet
define a static snapshot format.

## Gotchas

- `rpcFailureStatus` maps only `EXIT.DATAERR` to 400. A command that throws with
  `EXIT.USAGE` answers 500; the only 400 with `USAGE` is an unparseable JSON body.
- `successEnvelope` omits `warnings` when the list is empty, so a client must treat a
  missing key and an empty list the same.
- `ping` frames carry the server's `Date.now()` as their data, not a sequence number, and
  there is no `Last-Event-ID` resume.

## Where it came from

Extracted in September 2026 (TP-138) from `registry/src/envelope.ts` and the daemon's
`http.ts` and `events.ts`, unchanged on the wire. A real-socket test in `daemon` pins the
exact bytes of a success envelope, the error envelopes, and SSE frames.
