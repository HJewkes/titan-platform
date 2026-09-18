# Where code goes: mechanism, pixels, policy

Three homes, three npm identities, one direction of dependency. This guide is the long form
of the three questions in `CLAUDE.md`. Read it before you create a package, add a component,
or put logic in a product.

| Home | Publishes | Holds | Test |
| --- | --- | --- | --- |
| titan-platform `packages/*` | `@titan-design/<name>` | Mechanism: engines with no product opinion | Would a second product plausibly want it? |
| titan-design | `@titan-design/react-ui` | Pixels: components, app shell, tokens | Could any product render it without knowing the product's domain? |
| A product repo (codewatch, active-work, agent-chat, relay) | The product's own scope, for example `@codewatch/*` | Policy and surface: the decisions another product would make differently | Is it this product's vocabulary, defaults, prompts, or UI composition? |

Products depend on both libraries. Neither library knows any product exists. No library in
titan-platform imports one from titan-design or the reverse; only products cross that line.
A package name or source file in a library should not contain a product's name outside
historical comments.

## Mechanism versus policy

The same feature usually splits in two. The engine goes in a package; the opinion about how
to use it stays in the product.

| Mechanism (package) | Policy (product) |
| --- | --- |
| A rules engine that evaluates `check.json` with a baseline ratchet | The default rule set and thresholds a product ships |
| Tool runners for ruff, eslint, and similar | Which runners fire, with which pinned configs |
| Finding and violation types | Severity policy, what "not useful" feedback means |
| A workflow fan-out primitive with concurrency and budget caps | The audit workflow, its prompts, its taste rubric |
| A style profile schema and its exporters | The profiles a product recommends |
| A typed RPC client and a React data layer | The views, their composition, the static-export packaging |
| The command registry and daemon | The binary name, the command tree, the tool prefix |

When a piece is borderline, ask what changes if a second product adopts it. If the answer
is "nothing, it would import it", it is mechanism. If the answer is "it would want
different defaults", split it: parameters in the package, values in the product.

## The front end

Split by what each piece knows about.

- **titan-platform** gets everything that talks to the daemon: the wire contract, the typed
  client with its live and static data sources, React data and event hooks, the Vite
  dev-proxy preset, and the daemon's static-serve helper. These are server and build code
  tied to daemon routes, even when they are written in React.
- **titan-design** gets everything visual, including generic components a product needs
  first. A missing component is built there, not app-local, so the design system grows with
  each product. Components take props; they never fetch.
- **The product** owns page composition and nothing reusable.

## A product's own scope shrinks over time

A product that predates the platform starts with its engine published under its own name.
codewatch is the worked example: seven `@codewatch/*` packages, six of which are engine.
As each unit is ported, the product swaps its dependency to the `@titan-design/*` package,
deletes its copy, and the old package gets an `npm deprecate` notice that names its
successor. The end state is one or two packages: the CLI that provides the binary, and
possibly an app. The product scope is the recognizable front door, not a second home for
engines.

An extraction or port is not done until that swap and deletion have happened. Until then
there are two implementations, and they drift: `@titan-design/code-graph` was extracted
from codewatch in September 2026, never swapped back, and was a 14 percent subset of the
original ten days later.

## Port first, then extend

When existing product code is moving into a package, move it unchanged, prove it with a
differential test against the original, and only then extend it in its new home. A port
pull request adds no features, changes no semantics, and redesigns no API. The differences
it may contain are adapting to the platform's storage and conventions, and mechanical
splits to meet the file and function size limits. Improvements noticed along the way go
under "Not done, deliberately" in the pull request and become tasks.

A port pull request shows: every original test case present or listed with a reason, with
assertion counts compared; a differential run of original and port on the same real input;
a packed-tarball install for a new package; one named mutation and the test that caught it;
and the full gate. Mutations that survive are recorded as gaps in the original's tests, not
fixed in the port.

Bug fixes are not extensions. A defect found during a port is pinned by a test in the port,
then fixed in its own pull request with the behaviour change stated in the changeset.
