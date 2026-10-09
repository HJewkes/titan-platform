---
"@titan-design/registry": minor
---

Declare `Command.run` as a function-typed property instead of a method, so its context parameter is checked contravariantly. A command whose `run` needs a narrower context than `Ctx` no longer typechecks as a `Command<…, Ctx>`, an `AnyCommand` or an entry in a wider registry; before, the method's bivariant parameter let it through and it ran without the fields it reads. A command written for `BaseContext` still serves any product's registry. `commandToTool` and the CLI option helpers now take `AnyCommand<never>`, which accepts a command of any context, since they never call `run`. A consumer that relied on the bivariance gets a compile error at the widening.
