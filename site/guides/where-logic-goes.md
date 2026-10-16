# Where logic goes: rule file, recipe, step, service

[Where code goes](/guides/where-code-goes) says which repo a unit belongs in. This guide
says where a piece of logic lives inside the factory's pipeline. Name the home of every
new piece of logic before you write it. If it fits none of the four, the design is not
finished.

| Home | Holds | Test: does it belong here? |
| --- | --- | --- |
| Rule file | Policy as data | Could the owner change the behaviour by editing a table, with no new control flow? |
| Recipe | Control flow only | Does it only order, wait on, claim or overlap steps? |
| Step | Every effect and every read | Does it touch GitHub, disk, a process, the clock or the store? |
| Service | A recipe not keyed by one item | Does it act across items or subscribe to repo-wide events? |

## Rule file: policy as data

A rule file holds a decision the factory applies but does not make: the risk table, the
conformance and class steps, globs, the contract schema, the limits file, pool policies,
alarm routing and the rulesets. A new risk class is a new row, not a new `if`. Unknown
facts block, so a missing row fails closed.

Example: the requirement set per risk class is risk-table data (plan §2.2, §2.7). The
factory cannot write these files itself.

## Recipe: control flow only

A recipe is a script. Its body sees only `step`, `wait`, `claim`, `all` and pure helpers.
It decides the order and what to wait for, nothing else.

Example: a slice's recipe calls the step that meets `ci:green`, then waits on the
event that re-enters it. It never reads CI itself.

## Step: every effect and every read

A step is the only place something happens or is looked at. It has a name, schemas, an
effect class, a pin class, material inputs and an idempotency key, and it writes one
marker. A valid marker returns without running. Live reads are steps too, so what a
decision relied on is recorded and can be invalidated.

Example: the step that meets `landed` performs the merge. The recipe only calls it.

## Service: not item-keyed

A service is a recipe keyed by something other than one item. Services are the only
subscribers to repo-wide events; items own their markers.

Example: the merge queue, with candidates and a per-repo lander (plan §2.2). The review
pool runner, reconciler, pacer and console are the others.

## Old-path code

The D-M0-06 sunset manifest lists the paths the redesign replaces:
`products/factory/src/shepherd/**`, the burndown code and `scripts/seat/**`. Code on
those paths is a valid home for new logic only as a carve-out tagged
`superseded-at:<M>` (the milestone that replaces it) or `survives:<area>` (the area
that keeps it). An untagged addition there is a review finding: put the logic in one
of the four homes above.
