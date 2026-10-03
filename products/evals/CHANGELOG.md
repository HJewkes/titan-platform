# @titan-design/evals

## 0.1.1

### Patch Changes

- d8ea373: Record the resolved champion hash in a new `titan.trial/v1` record and carry it into the scorecard key, so trials against different champions never share a key.
- 83588c9: Accept an exact model id with a final `[1m]` suffix, so a 1M-context variant can be registered. Vertex (`@`) and Bedrock (`:`) id forms are accepted too; bare aliases, mixed case, spaces and `-latest` are still refused.

## 0.1.0

### Minor Changes

- df4102e: Add the evals product scaffold: spec schemas for unit, variant, case, suite, check and scorecard with strict and loose parsing, canonical content hashing that covers referenced prompt files, a `titan-evals validate` command, and one synthetic fixture unit.
