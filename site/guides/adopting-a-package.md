# Case study: adopting registry and daemon

active-work is a CLI, an MCP server, and an HTTP daemon over a workspace of initiatives,
tasks, sessions, and notes. It had its own command registry and its own server, both
hand-written, both the direct ancestors of `@titan-design/registry` and
`@titan-design/daemon`. In September 2026 it became the first product to consume them, in
place, without moving into this monorepo.

The numbers:

| Module | Before | After |
| --- | --- | --- |
| `src/registry/` | 117 lines, 4 files | 2 files, binding only |
| `src/server/` | 1,302 lines, 11 files | 632 lines |

About a thousand lines deleted across two pull requests, and all 1,321 tests unchanged
from the baseline.

## What made it cheap

Every product-specific fact went into a binding module, and nothing else in the codebase
learned that a package had arrived. Four bindings, one per seam:

- **`registry/types.ts`** binds the `Ctx` type parameter to active-work's `CommandContext`.
  All 60 command modules import `defineCommand` and `Command` from the same path as before.
- **`server/lifecycle.ts`** binds the package's pid helpers to active-work's single state
  root, so its eight importers are untouched.
- **`server/mcp.ts`** pins the `active__` tool prefix and the MCP handshake identity.
- **`server/http.ts`** supplies `createContext`, the `/health` index extension, and the
  `/ui` dashboard routes through `mountRoutes`.

`server/daemon.ts` composes `startDaemon` while keeping active-work's own session-index
watcher, which must close *before* the socket, because a refresh may be mid-transaction.
That ordering is product knowledge; the package cannot know it, so the product keeps it.

`logger.ts` was never touched. `daemon` types its `Logger` as anything with pino's
`(fields, message)` call signature, and active-work's pino instance satisfies it
structurally. No adapter, no binding, no diff.

[The binding pattern](/guides/binding-pattern) has the code.

## What nearly went wrong

The old implementation files were deleted along with their test files, and one of those
tests was the only surviving record of a real bug: `wrap --no-loops` had once shipped inert
because commander stores a negation as `false` under the *positive* key and never defines
the `noLoops` key at all. Deleting the test would have made the package free to regress it
silently. Those cases came back, pointed at the package's implementation, and
`collectCliArgs` in `@titan-design/registry` now carries that behaviour with a test that
proves it.

Two more risks were checked rather than assumed:

- **MCP tool names are public contract.** They appear in consumers' MCP client configs, so
  the adoption pinned all 60 of them to a fixture. A prefix change is now a test failure,
  not a support ticket.
- **The `/health` index payload** was verified against a live daemon rather than by reading
  code, because another process reads those exact field names cross-process.

The general lesson: when you delete an implementation in favour of a package, read its test
file before deleting it. Some of those cases are the only documentation of a bug you
already paid for.

## Two behaviour changes, both deliberate

`registry.list()` sorts by name where the old `Map` preserved insertion order. Help output
and MCP tool lists no longer depend on which module imported first, which is strictly
better and worth the diff in the golden files.

The live-reload SSE frame now names the watched root instead of the literal string
`active-root`. The dashboard listens for the event name and ignores the payload, so the one
real consumer was unaffected.

## A platform hazard worth repeating

Smoke-testing an adoption in isolation means redirecting the product's state directory. On
macOS, setting `XDG_DATA_HOME` does nothing: `env-paths` resolves to the real home anyway.
The first isolated run found the live daemon's pid file and correctly refused to start a
second daemon.

**`HOME` is the only lever that redirects state on darwin.** Set it, and set the product's
own root variable too, before you point a test at a "clean" state directory.

## The order that worked

1. Land the package first, published, with the behaviour the product needs.
2. Write the binding module, using the names the call sites already use.
3. Delete the old implementation — but move its tests onto the package before you do.
4. Run the suite unchanged. Edits to call sites mean the binding is incomplete.
5. Verify anything cross-process against a running instance, not against the source.
