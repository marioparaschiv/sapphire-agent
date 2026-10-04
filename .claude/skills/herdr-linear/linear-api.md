# Linear API and GitHub

The GraphQL operations the dispatcher sends (`src/linear.ts`), how team states and labels are resolved, and how the dispatcher reads and writes GitHub (`src/github.ts`).

## Client basics

- Endpoint `https://api.linear.app/graphql`, overridable via the `endpoint` option (tests point it at the fake server).
- Header `authorization: <raw API key>` (personal key, no `Bearer`).
- Any GraphQL `errors`, non-2xx, or unreadable body throws `LinearError` with the HTTP status and messages (`linear.ts:58-77`).
- Every response is parsed with zod.

## Operations

| Method | Operation | Used for |
| --- | --- | --- |
| `teams(names)` | `query Teams` | Teams by name with all workflow states. Every tick. |
| `poll(readyStateIds, claimedIds, questionIds)` | `query Poll` | Two aliased `issues` lists and the replies to question comments in one request. Every tick. |
| `moveIssue(id, stateId)` | `issueUpdate` | Move epic to Implementing or To Review. |
| `comment(id, body, parentId?)` | `commentCreate` | Flag comments, kept-worktree comments, thread replies. Returns the comment ID. |
| `react(commentId, emoji)` | `reactionCreate` | Mark a reply as delivered (`white_check_mark`). |
| `addLabel(id, teamId, name)` | `issueAddLabel` | Add `agent-stuck`. |
| `removeLabel(id, labelId)` | `issueRemoveLabel` | Remove `agent-stuck` when the PR is up. |
| `labelId` (private) | `query Labels`, `issueLabelCreate` | Find or create the label ID. |

`poll` details (`linear.ts:92-108`):

- `ready`: `issues(first: 50)` with state in the ready state IDs and `parent: { null: true }`.
- `claimed`: `issues(first: 250)` with `id in claimedIds`. `poll` throws when there are more than 250 claims, because a truncated page would release claims whose epics still exist.
- Epic fields: id, identifier, title, url, `branchName`, `sortOrder`, team, state, labels (with parent group name), `children(first: 1)` (only to know it has sub-issues).
- `replies`: `comments(first: 250)` with `parent.id in questionIds`: id, body, createdAt, parent id, reaction emojis. An empty list matches nothing.
- No pagination: more than 50 ready epics are cut off.

## State resolution (`dispatcher.ts:174-210`)

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

Repo labels (`resolveRepo`, `config.ts:67-104`), read from the epic's labels:

- `repo:<name>` (prefix `labels.repoPrefix`), or a label `<name>` inside a label group named `repo` (prefix minus trailing `:`; Linear shows it as `repo/<name>`).
- None: the team's `repo`. One: `<labelReposDirectory>/<name>`.
- Errors (claim `error` + comment): more than one repo label, team has no `labelReposDirectory`, or name not matching `^[A-Za-z0-9][A-Za-z0-9._-]*$`.

## GitHub (`src/github.ts`)

`GitHub` wraps the `gh` CLI. The `gh` runner is injected, so tests fake only the process boundary and assert the exact args and JSON bodies.

PR detection:

- `gh pr list --repo <owner/repo> --head <branch> --state all --json number,url,state,author`.
- Prefers an `OPEN` PR, else a `MERGED` one, else a `CLOSED` one. A `CLOSED` PR does not hand a run over; it only triggers worktree cleanup.
- Called when a run with a result file finishes, and each tick for `ended` / `kept` claims not in Shipped.
- Needs `gh` on the service `PATH` and authenticated for the service user. A `gh` failure aborts the tick.
- `owner/repo` comes from the repo's `origin` URL (`git.ts:23-35`), stored in `run.githubRepo`.

Writes (dispatcher only; the agent never posts to GitHub):

| Method | Call |
| --- | --- |
| `comment(repo, number, body)` | `gh api --method POST repos/<repo>/issues/<n>/comments --input -` with `{ body }`. |
| `review(repo, number, flags)` | `gh api --method POST repos/<repo>/pulls/<n>/reviews --input -` with `{ event: "COMMENT", body, comments: [{ path, line, side: "RIGHT", body }] }`. |
| `replyToThread(threadId, body)` | `gh api graphql --input -`, mutation `addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId, body })`. |
| `resolveThread(threadId)` | `gh api graphql --input -`, mutation `resolveReviewThread(input: { threadId })`. |

Thread scan (`pendingThreads(repo, branch)`): `gh api graphql --input -` with `{ query, variables }`, `repository.pullRequests(headRefName, states: OPEN, first: 1) { url reviewThreads(first: 100) { totalCount nodes { id isResolved comments(last: 100) { nodes { body pullRequestReview { body } } } } } }`. Returns the PR URL and the pending thread ids (rule in `claims-and-lifecycle.md`). Linear's public API has no field for PR comments, so this reads GitHub directly; Linear Diffs syncs threads both ways, so `/agent` written in Linear's review UI shows up here. `gh` exits non-zero on GraphQL errors.

- Every body ends with `ON_BEHALF_OF_CLAUDE`, the Linear `onBehalfOf` extension block. Linear shows such comments as written by Claude; it is the only way to tell agent comments from the user's, since both use one GitHub account.
- A COMMENT review on your own PR is allowed. Requesting review, approving or requesting changes is not, so instead of re-requesting review the summary comment ends with `Ready for review, @<PR author>.`, which notifies the user.

## Branch name

The branch is Linear's `branchName` for the epic (e.g. `mario/unb-12-settings-sync`), so Linear's GitHub integration links the PR to the epic.
