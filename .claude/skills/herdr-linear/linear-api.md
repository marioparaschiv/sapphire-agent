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
| `epicsByIdentifier(identifiers)` | Epics named by owned tabs and worktree branches that are not known otherwise (matched by team key and number). |
| `replies(questionIds)` | Replies in the threads of the current awaitingInput questions, at most 250, in one request. |
| `comments(issueId)` | Every comment on the epic, replies included, oldest first (paged). Used to look for a marker. |
| `moveIssue(issueId, stateId)` | Move the epic to Implementing or To Review. |
| `comment(issueId, comment, parentId?)` | Post a marked comment unless one with the same marker exists; returns its id either way. |
| `react(commentId, emoji)` | Mark a reply as delivered (`white_check_mark`), unless it already has that emoji. |
| `addLabel(issueId, teamId, name)` | Add `agent-stuck`. |
| `removeLabel(issueId, labelId)` | Remove `agent-stuck` once the result is posted. |

Epic fields: id, identifier, title, url, `branchName`, `sortOrder`, team, state, labels (with their parent group name), and `children(first: 1)`, only to know whether it has sub-issues.

## State resolution

- Each tick the `Observer` reads `teams(Object.keys(config.teams))`, matched by exact team name.
- Each role in `config.states` is matched by exact state name in that team.
- Team not found, or any state missing: the team is skipped and logged once per process, e.g. `team Unbound has no workflow state "To Review"; skipping it until it does`.
- Skipped teams: nothing is claimed, and their runs, tabs and worktrees are left untouched.
- State ids are kept per team id; moves use the run's team.
- An epic is finished (for the orphan worktree sweep) when its state's type is `completed` or `canceled`.

## Labels

`agent-stuck` (`labels.stuck`):

- A workspace label (no team) of that name wins over the team's label; a team label is created if neither exists.
- Label ids are cached per team and name for the process lifetime.

Repo labels (`resolveRepo`), read from the epic's labels:

- `repo:<name>` (prefix `labels.repoPrefix`), or a label `<name>` inside a label group named `repo` (the prefix without its trailing `:`; Linear shows it as `repo/<name>`).
- None: the team's `repo`. One: `<labelReposDirectory>/<name>`.
- Errors (a Permanent failure, so the epic is flagged): more than one repo label, the team has no `labelReposDirectory`, or a name not matching `^[A-Za-z0-9][A-Za-z0-9._-]*$`.

## GitHub (`GitHub` service)

Wraps the `gh` CLI through `ChildProcess`, each call under the call policy (20 s timeout, retries). It needs `gh` on the service `PATH`, authenticated for the service user. Tests use `FakeGitHub`.

PR detection (`findPullRequest`):

- `gh pr list --repo <owner/repo> --head <branch> --state all --json number,url,state,author`.
- Prefers an `OPEN` PR, else a `MERGED` one, else a `CLOSED` one. A `CLOSED` PR does not take a result; it only triggers cleanup.
- `owner/repo` comes from the repo's `origin` URL (`Git.githubRepo`).

Thread scan (`pendingThreads`): `gh api graphql --input -`, reading the branch's open PR (`pullRequests(headRefName, states: OPEN, first: 1)`) with its review threads (up to 100) and their comments with the review body each was submitted with. Returns the PR URL and the pending thread ids (rule in `rules.md`); none without an open PR. More threads than one page fails, since a truncated page could hide a pending thread. Linear's public API has no field for PR comments, so this reads GitHub directly; Linear's review UI syncs threads both ways, so `/agent` written there shows up here.

Writes (only the reconciler writes to GitHub; the agent never does). Each first looks for its marker and skips when present:

| Method | Call |
| --- | --- |
| `postSummary` | `gh api --method POST repos/<repo>/issues/<n>/comments --input -` with `{ body }`. |
| `postFlagsReview` | `gh api --method POST repos/<repo>/pulls/<n>/reviews --input -` with `{ event: "COMMENT", body, comments: [{ path, line, side: "RIGHT", body }] }`. The caller skips it when there are no flags. |
| `replyToThread` | `gh api graphql`, mutation `addPullRequestReviewThreadReply`. |
| `resolveThread` | `gh api graphql`, mutation `resolveReviewThread`; skipped when already resolved. |

- Every body ends with `ON_BEHALF_OF_CLAUDE`, Linear's `onBehalfOf` block, after the marker. Linear shows such comments as written by Claude; it is the only way to tell the agent's comments from the user's, since both use one GitHub account.
- A COMMENT review on your own PR is allowed. Requesting review, approving or requesting changes is not, so the summary ends with `Ready for review, @<PR author>.`, which notifies the user.
- A flag whose `line` is outside the diff makes GitHub reject the review (HTTP 422, Permanent): the epic is flagged with `permanentFailure`.

## Branch name

The branch is Linear's `branchName` for the epic (e.g. `mario/unb-12-settings-sync`), so Linear's GitHub integration links the PR to the epic. Identifiers are read back from branch names (`identifierOfBranch`) to find the epic of a worktree.
