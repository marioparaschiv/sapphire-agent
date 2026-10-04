# Linear API and GitHub

The GraphQL operations the dispatcher sends (`src/linear.ts`), how team states and labels are resolved, and how PRs are detected (`src/github.ts`).

## Client basics

- Endpoint `https://api.linear.app/graphql`, overridable via the `endpoint` option (tests point it at the fake server).
- Header `authorization: <raw API key>` (personal key, no `Bearer`).
- Any GraphQL `errors`, non-2xx, or unreadable body throws `LinearError` with the HTTP status and messages (`linear.ts:58-77`).
- Every response is parsed with zod.

## Operations

| Method | Operation | Used for |
| --- | --- | --- |
| `teams(names)` | `query Teams` | Teams by name with all workflow states. Every tick. |
| `poll(readyStateIds, claimedIds)` | `query Poll` | Two aliased `issues` lists in one request. Every tick. |
| `moveIssue(id, stateId)` | `issueUpdate` | Move epic to Implementing or To Review. |
| `comment(id, body)` | `commentCreate` | Stuck and failure comments. |
| `addLabel(id, teamId, name)` | `issueAddLabel` | Add `agent-stuck`. |
| `removeLabel(id, labelId)` | `issueRemoveLabel` | Remove `agent-stuck` when the PR is up. |
| `labelId` (private) | `query Labels`, `issueLabelCreate` | Find or create the label ID. |

`poll` details (`linear.ts:92-108`):

- `ready`: `issues(first: 50)` with state in the ready state IDs and `parent: { null: true }`.
- `claimed`: `issues(first: 50)` with `id in claimedIds`.
- Epic fields: id, identifier, title, url, `branchName`, `sortOrder`, team, state, labels (with parent group name), `children(first: 1)` (only to know it has sub-issues).
- No pagination: more than 50 ready epics are cut off.

## State resolution (`dispatcher.ts:146-182`)

- Each tick: `teams(Object.keys(config.teams))`, matched by exact team name.
- Each role in `config.states` is matched by exact state name in that team.
- Team not found, or any state missing: the team is skipped and logged once per process, e.g. `team Unbound has no workflow state "To Review"; skipping it until it does`.
- Skipped teams: no dispatch, and their claims are left untouched (not released).
- State IDs are keyed by team ID; moves use the claim's `teamId`.

## Labels

`agent-stuck` (`labels.stuck`), via `labelId` (`linear.ts:152-189`):

- Prefers a workspace label (no team) of that name, then the team's label.
- Creates a team label if neither exists.
- Cached per `teamId/name` for the process lifetime.

Repo labels (`resolveRepo`, `config.ts:65-102`), read from the epic's labels:

- `repo:<name>` (prefix `labels.repoPrefix`), or a label `<name>` inside a label group named `repo` (prefix minus trailing `:`; Linear shows it as `repo/<name>`).
- None: the team's `repo`. One: `<labelReposDirectory>/<name>`.
- Errors (claim `failed` + comment): more than one repo label, team has no `labelReposDirectory`, or name not matching `^[A-Za-z0-9][A-Za-z0-9._-]*$`.

## PR detection (`src/github.ts`)

- `gh pr list --repo <owner/repo> --head <branch> --state all --json url,state`.
- `CLOSED` (unmerged) PRs are ignored. Prefers an `OPEN` PR, else a `MERGED` one.
- Called once per tick for each claim in Implementing or In Review that has a `run`.
- Needs `gh` on the service `PATH` and authenticated for the service user. A `gh` failure aborts the tick.
- `owner/repo` comes from the repo's `origin` URL (`git.ts:23-35`), stored in `run.githubRepo`.

## Branch name

The branch is Linear's `branchName` for the epic (e.g. `mario/unb-12-settings-sync`), so Linear's GitHub integration links the PR to the epic.
