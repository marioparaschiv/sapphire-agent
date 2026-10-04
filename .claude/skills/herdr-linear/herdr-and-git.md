# herdr and git

How a run is started (worktree, trust, tab, `herdr agent start`), and how the Herdr, Git and ClaudeTrust services talk to herdr, git and `~/.claude.json`. The start rule's steps and their crash safety are in `rules.md`.

## Worktrees (`Git` service)

- Path: `<worktreesDirectory>/<basename(repo)>/<branch with [^A-Za-z0-9._-]+ replaced by ->`, e.g. `~/.herdr/worktrees/unbound/mario-unb-12-settings-sync`. Same layout as herdr's own worktrees.
- `prepareWorktree` always runs `git fetch origin` first, then:
  - path exists: reuse it if it has the same branch checked out, else fail Permanently;
  - local branch exists: `git worktree add <path> <branch>`;
  - only on origin: `git worktree add --track -b <branch> <path> origin/<branch>`;
  - new: `git worktree add --no-track -b <branch> <path> <origin default>`, so a plain `git push` never targets the default branch. The default comes from `origin/HEAD`, set with `remote set-head --auto` if missing.
- `pull`: `git pull --ff-only origin <branch>` for follow-up runs, so they start from what is on the PR. Origin is named explicitly since a branch created without tracking has no upstream.
- `unsavedWork`: uncommitted changes (`git status --porcelain`, untracked files count, ignored ones do not), or commits on the worktree's `HEAD` or the local branch that no `origin/*` ref contains (`N unpushed commits`). A branch never pushed is unsaved once it has commits beyond the default branch. No fetch first: `git push` already updates the remote-tracking ref.
- `removeWorktree`: `git worktree remove <path>` (no `--force`), `git worktree prune` (for a directory deleted by hand), `git branch -D <branch>`. Each step is skipped when already done, so it can run again after a crash. A later run starts again from `origin/<branch>`.
- `listWorktrees`: every worktree of a repo under the worktrees directory with a branch checked out (herdr's own included; ownership is decided by the cleanup rule).
- `githubRepo`: `owner/name` from the repo's `origin` URL, which must be GitHub.
- Result file: `herdr-result.json` in the worktree's git dir (`git rev-parse --absolute-git-dir`). `readResultFile` decodes it with the `ResultFile` schema and fails `InvalidResultFile` otherwise; `removeResultFile` deletes a leftover one when a run starts in a reused worktree.
- git calls in one repo share a semaphore, since git takes lock files in the main repo for all of its worktrees.

Done in git directly rather than `herdr worktree create`, which creates and opens its own workspace; herdr-linear needs a tab in the shared `agents` workspace plus the reuse and no-track rules above.

## Trust pre-accept (`ClaudeTrust` service)

- Sets `projects[<worktree>].hasTrustDialogAccepted = true` in `~/.claude.json` (override with `CLAUDE_CONFIG_PATH`), so Claude does not stop at the trust dialog. Every other field is kept as it is.
- Copies the file to `~/.claude.json.herdr-linear.bak` first, then writes atomically (temp file, fsync, rename).
- Claude rewrites the file often, so the write only lands if the file is still what was read; otherwise it starts over from the fresh contents, up to 5 times, then fails.
- Unparseable JSON fails instead of overwriting.

## The Herdr service

- Every command runs `$HERDR_BIN_PATH <args>` through `ChildProcess`; JSON stdout is `{ result }`, decoded with a `Schema`. A failed command writes `{ error: { code, message } }` to stderr, classified as in `failure-policy.md`.
- `pane_not_found`, `agent_not_found` and `tab_not_found` mean "not there": `pane`, `agent` and `tab` return none, `readTail` returns none, and `closeTab` returns false.
- `readTail`: `herdr pane read <pane> --source recent-unwrapped --lines <n>` (40 by default), with runs of blank lines squeezed to one.
- `prompt`: `herdr agent prompt <pane> <text>`, lines joined with spaces since herdr refuses newlines. herdr refuses it with `agent_blocked` while the agent sits at a dialog.
- `sendKeys`: `herdr agent send-keys <pane> <keys>` (the nudge sends `esc`).

### Tabs

- `openTab` looks for the workspace labelled `workspaceLabel` (default `agents`). Found: `herdr tab create --workspace <id> --label <label> --cwd <worktree> --env HERDR_BLANK=1 --no-focus`. Missing: `herdr workspace create --label agents` with the same flags, then `tab rename` of its first tab to the run's label.
- `HERDR_BLANK=1` makes the pane's shell skip its automatic Claude launch, so `agent start` gets a plain prompt; `--no-focus` keeps the user where they are.
- Tab label (`Prompts.tabLabel`): `<IDENTIFIER> <title, cut to 40 chars with an ellipsis>`. Starting with the identifier is how herdr-linear recognises the tabs it owns (`rules.md`).
- `workspaceTabs` lists every tab in that workspace with its root pane, agent and status; `identifier` is none for a tab whose label does not start with one. herdr's `agent_status` for a tab sums up the agents in all of its panes.
- `closeTab`: `herdr tab close <tabId>`. The rules only close a tab whose tab id and pane id both match the run.

### Starting Claude

`startClaude`: `herdr agent start <identifier lowercased> --kind claude --pane <pane> --timeout 30000 -- <prompt>`.

- It returns only when the agent is ready for input, which with an initial prompt means after that prompt's whole turn. So it nearly always times out, which means Claude is still starting.
- The start rule then reads `herdr agent get <pane>`: it must show `claude` with a status other than `blocked`, or the start fails with the pane tail.
- Claude already in the pane (e.g. after a crash right after the start) is not started again.
- The prompt must be one line.

### Events

- `events` is a `Stream` over the raw socket at `$HERDR_SOCKET_PATH` (`events.subscribe`): session-wide `pane.agent_detected`, `pane.exited`, `pane.closed`, `tab.closed`, and `pane.agent_status_changed` per owned pane (herdr needs a pane id for status subscriptions and takes one subscription request per connection).
- Only events of owned panes and tabs pass. An agent detected in a pane of the workspace that is not subscribed yet (a new run) ends the connection, and the next connection subscribes to it too.
- The stream never fails: it reconnects at once when a connection ends, and after 1 s, 2 s, 4 s ... up to 30 s when one fails.
- Events are not durable and closing a pane may emit nothing, so they only make a tick come sooner (`wake`); every tick reads herdr again, and that poll always wins.

## Known limits

- A crash right after `workspace create`, before the first tab is renamed, leaves that tab in the `agents` workspace under herdr's default label. It is not owned, so it is never touched; the next tick opens a new tab for the run. Close the stray one by hand.
