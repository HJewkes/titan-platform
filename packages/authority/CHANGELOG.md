# @titan-design/authority

## 0.4.0

### Minor Changes

- 2ff0840: Add the `decider` actor class and the `answer-question` action class. The decider is denied every action except `answer-question`, which the conditional ANS-DC-QA row allows only when `facts.question` names a `question` rule kind in `auto` mode on an untainted request; every other actor is denied `answer-question`. `decider` is never a resolver. Adds the `gate-rule-is-question` and `category-mode-auto` conditions, the `QuestionFacts` type, and `MERGE_CONDITION_KINDS` and `QUESTION_CONDITION_KINDS`.
- 69db518: Export `DELEGATE_RESOLVER_CLASSES` (`["coordinator"]`) and its `DelegateResolverClass` type: the only classes a gate's rule may name as a delegate resolver.
- c517313: Add the MRG-AU-RM allow row and its `verdict-merge-carried-remerge-clean` condition: an automation merge may carry the dispatched reviewer's MERGE to a head that is the reviewed head plus one merge of the base, when the merge's remerge-diff is empty or touches only the repo's declared generated files. `CarryFact` gains the optional `rule`, `remergePaths` and `generatedPaths` fields.

### Patch Changes

- dcde08d: `MergeFacts` gains an optional `contextApps` map: a run of a listed context counts toward `required-contexts-green` and `no-non-green-run` only from the apps listed for it, and every other context still uses `allowedApps`. A fact record without the field evaluates as before; a malformed map fails both conditions.
- 20778a2: Stop protecting `.github/` in the MRG-AU-RV path condition; `CODEOWNERS`, `docs/CODEOWNERS`, `.github/CODEOWNERS`, `.gitmodules` and non-canonical paths stay protected (owner decision of 2026-10-07, TP-1886).

## 0.3.0

### Minor Changes

- 32adb30: Add the `verdict-merge-carried-tree-equal` and `pr-kind-not-security` conditions and a separate automation row, MRG-AU-RC, that lets a MERGE verdict carry to a tree-equal head. It keeps every MRG-AU-RV condition except `verdict-merge-at-head`, which stays unchanged, and never carries `kind: security` or an unknown or missing kind. `MergeFacts` gains optional `carry` and `kind` facts. Shepherd's merge-facts collector fills `carry` only from the `sh-carry` step output and `kind` only from the run's registration.

## 0.2.2

### Patch Changes

- e54f34e: `evaluate` reads the actor class only from an own property, so a polluted `Object.prototype.class` can no longer supply one.

## 0.2.1

### Patch Changes

- 6e848b7: `evaluate()` now denies a request whose actor is missing, null, not an object, or carries no known actor class, instead of throwing.

## 0.2.0

### Minor Changes

- be51d27: Add row MRG-AU-RV (owner decision D-A): an automation merge is allowed when the run-dispatched reviewer's MERGE verdict names the exact full-length head sha, every required context has a `success` run at that head from a caller-supplied allowed app, no run from those apps is non-green, the merge-tree is clean, the repo is not frozen, no path under `.github`, root or `docs/` `CODEOWNERS`, or `.gitmodules` changes (compared case-insensitively, with any non-canonical or non-ASCII path, or a segment ending in a space or a dot, treated as protected), and the seat grants `merge-on-green-approve`. Otherwise, or unless `tainted` is an own property set to exactly `false`, MRG-AU still gates. Rules gain an optional `when` list of `CONDITION_KINDS`, checked against the new `AuthorityRequest.facts`; conditional rows are allow-only and do not count toward totality. `evaluate` reads each request field once and checks a `structuredClone` of the facts rebuilt as plain data; facts holding a function, a `toJSON` method, a Proxy, a Map, a Set, a Date, a BigInt, a cycle, a sparse array or a throwing getter fail every condition, the rebuild reads own properties only, and a class instance is copied as its own data. An inherited truthy `tainted` still escalates a `taintEscalates` row, as before. A missing or malformed fact fails its condition instead of throwing: booleans must be exactly `true` or `false`, ids non-empty strings, lists arrays, and a check run missing any field fails `no-non-green-run`. Adds `unmetConditions`, the `MergeFacts` types and the evidence kind `E-rev`.

## 0.1.0

### Minor Changes

- 1b02a8b: Add `@titan-design/authority`: the owner-approved authority decision table as data (`DEFAULT_TABLE` and `table.json`), `policyTableSchema` with totality and owner-only resolver checks, and the pure `evaluate` and `canResolve`.
