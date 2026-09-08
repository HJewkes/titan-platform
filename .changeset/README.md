# Changesets

Each `@titan-design/*` package versions independently (no `fixed` group): products pin
semver ranges on the packages they consume, so one package can ship a breaking change
without forcing a major on every sibling.

Add a changeset with `pnpm changeset` in the same PR as the change. `pnpm version-packages`
consumes pending changesets into version bumps and changelogs; `pnpm release` builds and
publishes whatever is bumped.
