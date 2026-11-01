# @titan-design/test-kit

Typed test doubles. `partialFake<T>(fields)` builds a `T` from only the fields a test uses,
so a test file needs no `as unknown as T` double cast, which the `titan/no-chained-type-assertions`
rule in `@titan-design/eslint-plugin` reports.

```ts
import { partialFake } from "@titan-design/test-kit";

const file = partialFake<ChangedFile>({ path: "docs/a.md" });
```

A field the test leaves out is `undefined` at run time even though `T` declares it. Fake every
field the code under test reads.

## Git fixtures: `@titan-design/test-kit/git`

Real-git tests spend most of their time starting git processes. This subpath builds each seed
repository once per test file, as a template, and gives every test a recursive copy, so a test
pays for no `git init`, seed commit or bare origin of its own. Each copy is the test's own:
changing its config, refs or history touches no other test.

```ts
import { gitIn, seedRepo, seedRepoWithOrigin, withHistory } from "@titan-design/test-kit/git";

seedRepo(dir, { "base.txt": "base\n" }); // main with one seed commit, no remote
seedRepoWithOrigin(work, origin);        // the same, plus a bare origin already holding main
seedRepo(dir, {});                       // an unborn main, for a test that writes its own history

const [m0, h1] = withHistory(dir, [
  { files: { "a.txt": "a0\n" } },
  { branch: "feature", from: "main", files: { "a.txt": "a1\n", "old.txt": null } },
]);
const git = gitIn(dir);
git("rev-parse", "HEAD"); // trimmed stdout; a non-zero exit throws
```

- `seedRepo(dir, files?)` and `seedRepoWithOrigin(dir, origin, files?)`: the template copy. The
  default seed is `README.md`. Templates turn off auto-maintenance and gc (`maintenance.auto`,
  `gc.auto=0`, `receive.autogc`), skip fsync (`core.fsync=none`), set a commit identity, and have
  an empty hooks directory. Templates are deleted in `afterAll`; `removeTemplates()` and
  `templateDirectory()` expose that for a test of the cleanup itself.
- `withHistory(dir, commits)`: writes many commits with one `git fast-import`, then checks out
  the last commit's branch. Commit dates are pinned, one second apart, so the shas it returns are
  the same on every run. A `null` file deletes the path. `from` names the parent: a branch,
  `:n` for the history's nth commit (from 1), or a full sha. A commit's own `date` (any string
  `Date.parse` reads) replaces its pinned one, and `author` names its author, as
  `<author>@example.com`, for tests that count authors or windows by date.
- `fixtureEnv()`: the environment every helper runs git with. It drops the `GIT_CONFIG_*` entries
  a session may inject (an agent session's push hook refuses scratch remotes), ignores system and
  global config, and fixes the author and committer. Pass it to the code under test when that code
  spawns git itself.
- `gitIn(cwd)`: `git -C cwd ...` under `fixtureEnv`.

The subpath imports `vitest` (an optional peer dependency) for its `afterAll` cleanup; the root
entry does not.

Tier 0 of the titan-platform DAG. May import only packages in the same tier or
below; the `package-layers` rule in `.codewatch/check.json` enforces this in CI. Install it as a
dev dependency.

Status: unpublished. The first version is published by hand; see the repo `CLAUDE.md`.
