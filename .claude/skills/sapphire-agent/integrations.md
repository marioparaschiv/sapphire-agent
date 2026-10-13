# Integrations

Every method runs under the call policy (`failure-policy.md`); every response is decoded with a `Schema`.

## Linear (`linear.ts`)

GraphQL over `HttpClient` at `https://api.linear.app/graphql`, header `authorization: <raw personal API key>` (no `Bearer`; `Redacted` in code and logs).

| Method | Used for |
| --- | --- |
| `teams(names)` | Teams by exact name with all workflow states. Every tick. |
| `readyEpics(stateIds)` | Top-level issues (`parent: null`) in the ready states, first 50 (more are cut off), with inverse relations (type, related issue's identifier and state type) for holds. Every tick. |
| `epics(ids)` | The journal's epics wherever they are. Every tick. Over 250 fails Permanently (a truncated page would make live epics look gone). |
| `epicsByIdentifier(identifiers)` | Epics named by worktree branches (by team key and number), by `sapphire dispatch`, and of notices the tick did not observe. |
| `epicTree(epicId)` | The epic and its sub-issues (first 50) with title, description, state, labels and inverse relations, for the epic-edits rule (`rules.md`, Epic edits). Every tick, per run in flight. |
| `issueHistories(ids)` | Newest 50 history entries per issue (`botActor`; title, description, state, label, relation and parent changes), to tell an edit by one of Linear's automations (`botActor` set) from the others; the bot's own edits by design are left out by target state instead, since its API key and the run's agent both act as the owner. Only for issues with a difference not already left out. |
| `moveIssue(issueId, stateId)` | To Implementing or To Review (or Ready, by `sapphire dispatch`). |
| `comment(issueId, comment)` | `PR opened` and every notice, unless a comment on the epic (all, paged) has its marker. |
| `addLabel(issueId, teamId, name)`, `removeLabel(issueId, labelId)` | `agent-stuck`. |

Epic fields: id, identifier, title, url, `branchName`, `sortOrder`, `createdAt`, team, state, labels (with parent group name), `parent { identifier }` (`sapphire dispatch` refuses sub-issues), `children(first: 1)` (has sub-issues?).

**States**: each role in `config.states` matched by exact name in the team (`sapphire project add` checks the team the same way). Team missing or lacking a state: skipped, logged once per process (`team Unbound has no workflow state "To Review"; skipping it until it does`); nothing claimed, its runs and worktrees untouched. State ids kept per team; moves use the run's team. Finished (for orphans) means state type `completed` or `canceled`.

**`agent-stuck`** (`labels.stuck`): a workspace label of that name wins over the team's; a team label is created if neither exists. Ids cached per team and name for the process.

**Repo labels** (`resolveRepo`): `repo:<name>` (`labels.repoPrefix`), or `<name>` in a label group named `repo` (the prefix minus `:`; Linear shows `repo/<name>`). None: the project's `repo`; one: `<labelReposDirectory>/<name>`. Permanent (flags the epic): team not a project, more than one, no label repos directory, or a name not matching `^[A-Za-z0-9][A-Za-z0-9._-]*$`.

**Branch**: Linear's `branchName` (e.g. `mario/unb-12-settings-sync`), so Linear's GitHub integration links the PR. `identifierOfBranch` reads identifiers back to find a worktree's epic.

## GitHub (`github.ts`)

`gh` via `ChildProcess`. Reads as the user (default gh login, `gh` on the service `PATH`); every write as the App, with the repo's installation token as `GH_TOKEN`. Only the reconciler writes to GitHub. Mentions arrive as webhook deliveries, not via `gh`; Linear's review UI syncs threads both ways, so a mention there is delivered too.

- `findPullRequest`: `gh pr list --repo <owner/repo> --head <branch> --state all --json number,url,state,author`; prefers `OPEN`, else `MERGED`, else `CLOSED`. A `CLOSED` PR takes no result, only triggers cleanup. `owner/repo` from `Git.githubRepo`.
- `postComment`: `gh api --method POST repos/<repo>/issues/<n>/comments --input -` with `{ body }`; marker looked for among the newest 100 comments (`issueOrPullRequest`).
- `addThumbsUp`: GraphQL `addReaction` `THUMBS_UP` by node id.
- `replyToThread`: `gh api graphql` `addPullRequestReviewThreadReply`.
- `resolveThread`: `resolveReviewThread`, skipped when resolved.

## GitHub App (`github-app.ts`)

`HttpClient` against `https://api.github.com` (base URL is the layer's argument). Each call signs a fresh RS256 JWT with `bot.app.privateKeyFile` (`iss` App ID, `iat` 60 s back, `exp` 10 min after `iat`).

- Startup: `GET /app` gives the slug; `login` is `<slug>[bot]`, how its comments are recognised. Failure stops startup.
- `installationToken(repo)`: `GET /repos/<owner>/<name>/installation`, then the cached token, or `POST /app/installations/<id>/access_tokens`. Reused until 5 min before `expires_at` (tokens last an hour), memory only. No installation: Permanent (404).

## T3 (`t3.ts`)

MCP client of T3 Code over `HttpClient`: `POST <t3.url>/mcp` with the bearer token. Opens a session (`initialize`, then `notifications/initialized`; `mcp-session-id` and `mcp-protocol-version` on later requests), reopens on 404, reads JSON or SSE replies, prefers `structuredContent`. Tools: `ping`, projects (list, create), threads (launch, list, read, wait, send, interrupt, settle via `t3_thread_organize`), each decoded to the fields the rules use.

**Launches**: one full-access thread per claimed run in the repo's T3 project, titled `<ID> <title cut to 40 chars with an ellipsis>` (`Prompts.threadTitle`), `runtimeMode: "full-access"`. Every launch (`T3.launchThread`) passes `modelSelection`, T3's default model read from `t3.settingsFile` (T3 refuses a launch without one in a project lacking a default). New run: `workspaceStrategy` `{ type: "worktree", baseRef: <origin default branch>, branch: <epic branch>, startFromOrigin: true }`; T3 makes the worktree after answering. A worktree already on the branch, every follow-up and every handoff thread use `existing_worktree`. Commands: `rules.md`, Commands.

## Git (`git.ts`)

- Worktree path: `<worktreesDirectory>/<basename(repo)>/<branch with [^A-Za-z0-9._-]+ replaced by ->`, e.g. `~/.t3/worktrees/unbound/mario-unb-12-settings-sync`. T3's own layout, so `worktreesDirectory` must equal T3's setting.
- `prepareWorktree` (follow-ups): `git fetch origin`, then: path exists, reuse if on the same branch, else Permanent; local branch exists, `git worktree add <path> <branch>`; only on origin, `git worktree add --track -b <branch> <path> origin/<branch>`; new, `git worktree add --no-track -b <branch> <path> <origin default>` (so a plain `git push` never targets the default). The default is `origin/HEAD`, set with `remote set-head --auto` if missing.
- `pull`: `git pull --ff-only origin <branch>` (explicit origin: untracked branches have no upstream).
- `checkoutDefaultBranch`: worktree of a clone at `$STATE/commands/<repo>`, detached at origin's default as fetched now; made if missing.
- `unsavedWork`: uncommitted changes (`git status --porcelain`; untracked count, ignored do not), or commits on `HEAD` or the local branch no `origin/*` ref contains (`N unpushed commits`). Commits in a merged PR's head (`headRefOid`) count as pushed, so a squash merge with a deleted branch is fine. A never-pushed branch is unsaved once it has commits beyond the default. No fetch first.
- `removeWorktree`: `git worktree remove <path>` (no `--force`), `git worktree prune`, `git branch -D <branch>`, each skipped when done. A later run starts again from `origin/<branch>`.
- `listWorktrees`: worktrees of a repo under the worktrees directory with a branch checked out.
- `githubRepo`: `owner/name` from `origin`, which must be GitHub.
- Result file: `sapphire-agent-result.json` in the worktree's git dir (`git rev-parse --absolute-git-dir`; the orchestrate skill uses `--git-dir`), so never committed. `readResultFile` decodes `ResultFile` or fails `InvalidResultFile`; `removeResultFile` deletes a leftover in a reused worktree.
