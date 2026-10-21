# Story spine: <video id>

## 1. Viewer
- Who: <persona>. Knows: <list>. Needs, after watching: <1-3 outcomes>.

## 2. Problem (two sentences at most)
<What hurts today, in the viewer's units, with one fact id.>

## 3. Journey: one task from "<thing we want to build>" to "<merged / deployed>"
| # | Step | What happens (one clause) | Why it is needed (what goes wrong without it) | Invariant it must keep | Today: how it breaks (fact id) |
|---|---|---|---|---|---|
| 1 | ... | ... | ... | <invariant id> or — | <fact id> or — |

## 4. Architecture that carries the task
| Part (map node) | Carries step(s) | Mechanism for each invariant it keeps | Constraint that forces it |
|---|---|---|---|

## 5. Constraints (fixed, not chosen)
| Constraint | The mechanism it forces (a part from §4) |
|---|---|

## 6. Item ledger: every name the viewer will meet
| Item | Kind (step / property / constraint / invariant / part / number / concept / left-out) | Defined in beat | Reused in beats |
|---|---|---|---|

Kinds: `part` is only a §4 map node, or a mechanism the design removes or keeps. Declare a removed mechanism
`part` whatever its label's wording ("no coordinator in the loop"). A noun of the model that is not a map node is a
`concept`. An item named only to say it is left out (§7) is `left-out`.

## 7. Cut list
<Items in the source doc this video deliberately does not name, and why.>

## 8. Chapter order (derived from §2-§5, not from the source doc)
| Ch | Question | Spine rows it covers |
|---|---|---|

## 9. List shapes (optional: a beat not named here is `parallel`)
| Beat | Shape (parallel / contrast) |
|---|---|
| <beat id> | contrast |

A `parallel` list sets out entries of one kind, and its kinds are compared. A `contrast` beat sets an old thing
against its replacement and the reason (a removal card), or old pins against new on a split map. Its entries
differ in kind by design, so they are never compared.
