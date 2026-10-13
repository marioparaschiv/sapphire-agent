# Linear API and GitHub

The `Linear` service (`src/linear.ts`), how team states and labels are resolved, and the `GitHub` service (`src/github.ts`).

## Linear client basics

- GraphQL over Effect's `HttpClient`, endpoint `https://api.linear.app/graphql` (tests point it at the Linear fixture server).
- Header `authorization: <raw API key>` (personal key, no `Bearer`). The key is `Redacted` in code and logs.
- Every response is decoded with a `Schema`. Failures are classified as in `failure-policy.md`; each method runs under the call policy (20 s timeout, retries).

## Operations

| Method | Used for |
| --- | --- |
| `teams(names)` | Teams by exact name with all workflow states. Every tick. |
| `readyEpics(stateIds)` | Top-level issues (`parent: null`) in the ready states, first 50. Every tick. More than 50 are cut off. |
| `epics(ids)` | The journal's epics wherever they are now. Every tick. More than 250 fails Permanently, because a truncated page would make epics that still exist look gone. |
| `epicsByIdentifier(identifiers)` | Epics named by worktree branches that are not known otherwise (matched by team key and number), by `sapphire dispatch`, and the epics of notices the tick did not observe. |
| `epicTree(epicId)` | The epic and its sub-issues (first 50) with title, description, state, labels and `blocks` relations onto them, for the epic-edits rule. Every tick, per run in flight. |
| `issueHistories(ids)` | The newest 50 history entries of each issue (`botActor`, and the title, description, state, label, relation and parent changes), to tell an edit by one of Linear's automations (`botActor` set) from the others. Only for issues with a difference the epic-edits rule does not leave out by design. |
| `moveIssue(issueId, stateId)` | Move the epic to Implementing or To Review (or to Ready, by `sapphire dispatch`). |
| `comment(issueId, comment)` | Post `PR opened: <url>` and every notice, unless a comment on the epic (every one, paged) carries its marker already. |
| `addLabel(issueId, teamId, name)` | Add `agent-stuck`. |
| `removeLabel(issueId, labelId)` | Remove `agent-stuck` once the result is posted. |

Epic fields: id, identifier, title, url, `branchName`, `sortOrder`, `createdAt` (for `dispatchSettleSeconds`), team, state, labels (with their parent group name), `parent { identifier }` (set for a sub-issue, which `sapphire dispatch` refuses), and `children(first: 1)`, only to know whether it has sub-issues.

## State resolution

- Each tick the `Observer` reads `teams(<the projects' team names>)`, matched by exact team name. `sapphire project add` checks the team exists the same way.
- Each role in `config.states` is matched by exact state name in that team.
- Team not found, or any state missing: the team is skipped and logged once per process, e.g. `team Unbound has no workflow state "To Review"; skipping it until it does`.
- Skipped teams: nothing is claimed, and their runs and worktrees are left untouched.
- State ids are kept per team id; moves use the run's team.
- An epic is finished (for the orphan worktree sweep) when its state's type is `completed` or `canceled`.

## Labels

`agent-stuck` (`labels.stuck`):

- A workspace label (no team) of that name wins over the team's label; a team label is created if neither exists.
- Label ids are cached per team and name for the process lifetime.

Repo labels (`resolveRepo`), read from the epic's labels:

- `repo:<name>` (prefix `labels.repoPrefix`), or a label `<name>` inside a label group named `repo` (the prefix without its trailing `:`; Linear shows it as `repo/<name>`).
- None: the project's `repo`. One: `<labelReposDirectory>/<name>`.
- Errors (a Permanent failure, so the epic is flagged): the team is not a project, more than one repo label, the project has no label repos directory, or a name not matching `^[A-Za-z0-9][A-Za-z0-9._-]*$`.

## GitHub (`GitHub` service)

Wraps the `gh` CLI through `ChildProcess`, each call under the call policy (20 s timeout, retries). It needs `gh` on the service `PATH`, authenticated as the user (the default gh config), for reads. Every write runs as the GitHub App, with the repo's installation token as `GH_TOKEN` on top of the service's env. Tests use `FakeGitHub`.

## GitHub App (`GitHubApp` service)

`github-app.ts`, over `HttpClient` against `https://api.github.com` (the base URL is the layer's argument), each call under the call policy (20 s timeout, retries; 429 and 5xx are Transient, other non-2xx Permanent with GitHub's `message`). Every call authenticates as the App with a fresh RS256 JWT signed by `bot.app.privateKeyFile` (`iss` the App ID, `iat` 60 s back, `exp` 10 min after `iat`).

- At startup, `GET /app` gives the slug; `login` is `<slug>[bot]`, how the App's comments are recognised. A failure here stops startup.
- `installationToken(repo)`: `GET /repos/<owner>/<name>/installation` for the installation id, then the cached token of that installation, or `POST /app/installations/<id>/access_tokens` for a new one. A token is reused until 5 min before its `expires_at`, in memory only. A repo without the App installed fails Permanently (HTTP 404).

Tests use `GitHubAppFixture` (`development.md`).

PR detection (`findPullRequest`):

- `gh pr list --repo <owner/repo> --head <branch> --state all --json number,url,state,author`.
- Prefers an `OPEN` PR, else a `MERGED` one, else a `CLOSED` one. A `CLOSED` PR does not take a result; it only triggers cleanup.
- `owner/repo` comes from the repo's `origin` URL (`Git.githubRepo`).

Mentions are not read through `gh`: they arrive as the App's webhook deliveries (`rules.md`, Mentions). Linear's review UI syncs threads both ways, so a mention of the bot written there lands on GitHub and is delivered like any other.

Writes (only the reconciler writes to GitHub, always as the GitHub App; the agents never do). Each comment first looks for its marker and skips when present:

| Method | Call |
| --- | --- |
| `postComment` | On the PR (`Addressed your concerns inline.`), or on the issue or PR of a command's comment (its replies and its failure): `gh api --method POST repos/<repo>/issues/<n>/comments --input -` with `{ body }`. The marker is looked for among the newest 100 conversation comments of the issue or PR (`issueOrPullRequest`). |
| `addThumbsUp` | A `THUMBS_UP` reaction on a mention's comment or review, by node id: GraphQL `addReaction`. No marker is needed, as GitHub keeps one reaction of each kind per user. |
| `replyToThread` | `gh api graphql`, mutation `addPullRequestReviewThreadReply`. |
| `resolveThread` | `gh api graphql`, mutation `resolveReviewThread`; skipped when already resolved. |

- The summary and the self-review flags are not posted on GitHub: they are notices, posted on the Linear epic (`rules.md`, Results).

## Branch name

The branch is Linear's `branchName` for the epic (e.g. `mario/unb-12-settings-sync`), so Linear's GitHub integration links the PR to the epic. Identifiers are read back from branch names (`identifierOfBranch`) to find the epic of a worktree.
