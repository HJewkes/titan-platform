# Set up the autonomous build-and-merge loop

This guide is for someone who stands up the loop on a new machine or for their own
repositories. It says what to create and why. It does not repeat the product guides; it
links to them.

## The loop

An agent opens a pull request and registers it with Shepherd, the PR watcher in
`products/factory`. Shepherd waits for CI, gets a reviewer verdict and merges through the
GitHub API with the head SHA pinned, so a push after the review can never ride along. A
`FIX_FIRST` verdict goes to a fixer agent, and the loop starts again on the new head. Agents
only review and fix. Code owns the state, the policy, the retries and the merge. See
[Shepherd](/guides/shepherd) for the phases.

## The GitHub App

The Release workflow opens the "Version Packages" pull request. GitHub starts no workflows
for pushes made with the built-in `GITHUB_TOKEN`, so that pull request would get no CI and
the required checks would never report. Commits pushed with that token are also authored by
`github-actions[bot]`, and a ruleset with `require_extra_approval_for_unattributed_changes`
then wants an owner review on every release.

A GitHub App fixes both. The workflow mints an installation token with
`actions/create-github-app-token`, pushes the branch with it, and passes
`commitMode: github-api` to `changesets/action`. Commits made through the API with an App
token are attributed to the App.

### Settings

Create the App on the account that owns the repository.

| Setting | Value |
| --- | --- |
| Name | `titan-platform-release` (any name works) |
| Webhook | off |
| Repository permissions | Metadata read, Contents read and write, Pull requests read and write |
| Where it can be installed | only on this account |
| Installation | only the repositories that release with it |

The `https://github.com/settings/apps/new` page accepts URL parameters that fill the form.
This link sets the name, turns the webhook off and requests the three permissions:

```
https://github.com/settings/apps/new?name=my-release-app&url=https://github.com/OWNER/REPO&webhook_active=false&public=false&contents=write&pull_requests=write&metadata=read
```

Check every field before you press Create. Then install the App on the repository.

### Secret and variables

| Name | Kind | Holds |
| --- | --- | --- |
| `RELEASE_APP_PRIVATE_KEY` | repository secret | the App's private key, the whole `.pem` file |
| `RELEASE_APP_CLIENT_ID` | repository variable | the App's client ID; the workflow passes it as `client-id` |
| `RELEASE_APP_ID` | repository variable | the App ID, kept for tools that still take `app-id` |

Set the secret from the file so the key never appears on screen:

```sh
gh secret set RELEASE_APP_PRIVATE_KEY --repo OWNER/REPO < key.pem
```

### Rotate the key

1. On the App's settings page, generate a new private key. GitHub downloads a `.pem` file.
2. Run `gh secret set RELEASE_APP_PRIVATE_KEY --repo OWNER/REPO < key.pem`.
3. Delete the `.pem` file from disk.
4. On the App's settings page, delete the old key.

Re-run the Release workflow to confirm the new key mints a token.

## npm trusted publishing

The App token does not touch npm. The workflow keeps `id-token: write` and publishes with
npm trusted publishing (OIDC). No npm token exists anywhere, and none should be added.

A brand-new package cannot use that path yet. Its first version is published once, by hand,
from the owner's own terminal, and then the trusted publisher is added on npmjs.com. The
steps are in the Releasing section of the repository `CLAUDE.md` and in
[Working in the repo](/guides/contributing#releasing). Follow them as written.

## Rulesets

Protect the default branch with a ruleset, not with the older branch protection rules.

- Require the status checks that prove a pull request is safe: here `dag-check`,
  `egress-scan`, `hub-compose` and `validate`.
- Require a pull request, and set `require_extra_approval_for_unattributed_changes` if you
  want unattributed commits to need a review.
- Give the ruleset no bypass actors. Not the App, not an admin, not the owner. A merge that
  passes the checks needs no bypass, and one that cannot pass should not merge.

## The factory service

Shepherd runs inside `titan-factory`. Install it as a launchd service so runs survive the
shell:

```sh
titan-factory service install
titan-factory service status
titan-factory service restart
```

The state is a SQLite database under `$XDG_STATE_HOME/titan-factory`. Logs sit in the same directory. `GET /health` on the
service port (default 7410) reports run counts, pending gates, the GitHub probe, the version
and the pid. Full detail is in [Factory](/guides/factory#install-as-a-service).

The service runs the code it was built from. After a merge that changes the factory, pull
main, rebuild and run `titan-factory service restart`. A service that was not redeployed
keeps the old behavior.

## Shepherd seat policy

A seat file says which repositories a seat owns and what its agents may do. For merges there
are two working modes:

- **Merge on green.** The seat grants `merge-on-green-approve`. After CI is green and a
  reviewer says `MERGE`, Shepherd merges with no human step.
- **Owner gate.** The default for any repository no seat lists. Shepherd stops at a gate and
  waits.

A gate is a recorded question that only the owner can answer, such as `approve-merge`. The
run stays open and holds its place. The owner answers with `titan-factory gate resolve`,
which is CLI-only on purpose: no MCP tool or HTTP route can answer a gate. See
[seat policy](/guides/shepherd#seat-policy) and
[resolving a gate](/guides/shepherd#resolving-a-gate-is-cli-only).

## Claude Code prerequisites

Keep these general. Your own values live in your own configuration.

- **agent-chat.** Run its broker, and define the agent profiles that the coordinator
  launches for implementers, reviewers and fixers.
- **Auto mode grants.** Claude Code's permission classifier denies an agent a merge or a
  Version Packages merge unless a grant allows it. Add the grants under `autoMode.allow` for
  the exact commands the loop needs: the Shepherd merge, and approving CI runs on Version
  Packages pull requests. Scope each grant to your repositories.
- **Where the grants live.** Keep them in a dotfiles base file plus a machine-local patch.
  Do not put them in a templated settings file. `chezmoi re-add` skips a templated file, so
  an edit there would silently never reach your dotfiles.
