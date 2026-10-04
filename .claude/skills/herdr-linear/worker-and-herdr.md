# Worker and herdr

How the worker starts a Claude Code run (worktree, trust, tab, `herdr agent start`) and how it watches the agent afterwards.

## Dispatch sequence (`worker.ts:118-157`)

1. `prepareWorktree(repoPath, branch, worktreesDirectory)`. Follow-up runs (`job.threadIds`) then run `git pull --ff-only origin <branch>` (`pullBranch`), so they start from what is on the PR.
2. `githubRepo(repoPath)`: `owner/repo` from `origin` (must be GitHub). Delete a leftover result file from an earlier run.
3. `trustFolder(~/.claude.json, worktree)`.
4. `openTab(tabLabel, worktree)`.
5. `herdr agent start`, then confirm with `herdr agent get`.
6. Send `started { run }` and begin tracking.

Any throw becomes a `failed` message (`startRun`). Errors after the tab exists carry the last 40 pane lines.

Starts (dispatch and adopt) and cleanups run one at a time through `serial`, so parallel epics never race on `~/.claude.json`, on creating the `agents` workspace, or on git's worktree locks. Watching runs is fully parallel.

## Worktrees (`src/git.ts`)

- Path: `<worktreesDirectory>/<basename(repoPath)>/<branch with [^A-Za-z0-9._-]+ replaced by ->`, e.g. `~/.herdr/worktrees/unbound/mario-unb-12-settings-sync`. Same layout as herdr's own worktrees.
- Always `git fetch origin` first.
- Path exists: reuse it if it has the same branch checked out, else throw.
- Local branch exists: `git worktree add <path> <branch>`.
- Only on origin: `worktree add --track -b <branch> <path> origin/<branch>`.
- New: `worktree add --no-track -b <branch> <path> <origin default>`, so a plain `git push` never targets the default branch. Default comes from `origin/HEAD`, set with `remote set-head --auto` if missing.

Cleanup (`unsavedWork`, `removeWorktree`):

- Kept if `git status --porcelain` is non-empty (untracked files count, ignored ones do not): `uncommitted changes`.
- Kept if the worktree's `HEAD` or the local branch has commits that no `origin/*` ref contains: `N unpushed commits`. A branch never pushed is unpushed once it has commits beyond the default branch. No fetch first: `git push` already updates the remote-tracking ref.
- Otherwise `git worktree remove <path>` (no `--force`), `git worktree prune` (for a directory deleted by hand), `git branch -D <branch>`. Each step is skipped if already done, so a second cleanup is a no-op.
- A later run (e.g. a follow-up) then starts again from `origin/<branch>` through `prepareWorktree`.

Done in git directly rather than `herdr worktree create`, which creates and opens its own workspace; this code needs a tab in the shared `agents` workspace plus the reuse and no-track rules above.

## Trust pre-accept (`src/trust.ts`)

- Sets `projects[<worktree>].hasTrustDialogAccepted = true` in `~/.claude.json` (override: `CLAUDE_CONFIG_PATH`), so Claude does not stop at the trust dialog.
- Writes a backup to `~/.claude.json.herdr-linear.bak` first.
- Optimistic: re-reads before writing and retries up to 5 times if Claude changed the file meanwhile, then throws.
- Unparseable JSON throws instead of overwriting.

## Tabs (`worker.ts:159-173`, `herdr.ts:84-109`)

- Looks for a workspace labelled `workspaceLabel` (default `agents`).
- Found: `herdr tab create --workspace <id> --label <tabLabel> --cwd <worktree> --env HERDR_BLANK=1 --no-focus`.
- Missing: `herdr workspace create --label agents ...` with the same flags, then `tab rename` to the tab label.
- `HERDR_BLANK=1` makes the pane shell skip its automatic Claude launch, so `agent start` gets a plain prompt.
- Tab label: `<IDENTIFIER> <title, cut to 40 chars with an ellipsis>` (`dispatcher.ts:629`). Adopt finds tabs by this exact label.

## Closing tabs (`closeRun`)

- On `close` and at the start of `cleanup`: stop tracking the run, `herdr tab get <tabId>`, and `herdr tab close <tabId>` only if the tab's label is still the job's `tabLabel`. After a herdr restart the same tab id can belong to another tab.
- `tab_not_found` means already closed; not an error.
- Errors are logged (`closing <ID>'s tab failed: ...`); a `cleanup` closes the tab again later.

## `herdr agent start` quirks (`herdr.ts:160-164`, `worker.ts:137-151`)

Command: `herdr agent start <identifier lowercased> --kind claude --pane <pane> --timeout 30000 -- <prompt>`.

- It returns only when the agent is ready for input, which with an initial prompt means after that prompt's whole turn. So it nearly always times out.
- A `HerdrError` with code `timeout` is treated as "still starting". Any other error fails the run.
- Then `herdr agent get <pane>` must show `agent: claude` with status other than `blocked`; otherwise `failed` with the pane tail.
- The prompt must be one line. herdr refuses to pass newlines to the shell (`dispatcher.ts:631-635`).

## CLI wrapper (`src/herdr.ts`)

- Every call is `execFile($HERDR_BIN_PATH, args)`; JSON stdout is `{ result }`, parsed with zod.
- Errors: stderr JSON `{ error: { code, message } }` becomes `HerdrError(code)`.
- `pane_not_found` / `agent_not_found` map to `undefined` in `pane()` and `agent()`.
- `readPane` uses `--source recent-unwrapped` and squeezes blank-line runs.

## Watching a run (`worker.ts:46-52, 246-342`)

- Events: raw socket at `$HERDR_SOCKET_PATH`, `events.subscribe` for `pane.agent_status_changed`, `pane.agent_detected`, `pane.exited`, `pane.closed`, each filtered by `pane_id` (subscriptions need it).
- Events only trigger a reconcile; their payload is ignored.
- Events are not durable and closing a pane emits nothing (`pane.closed` is subscribed but not relied on), so every tracked run is also reconciled every `pollSeconds`.
- On socket close the worker resubscribes after `pollSeconds`.
- Reconcile: pane gone gives `finished vanished`; pane alive but no Claude gives `finished exited` with tail. Otherwise the tail is read every time and a status or tail change gives `status`, so the dispatcher can see a `working` agent's output stop.
- Result file: read when the agent is not `working`, and before `finished`. Reported once per tracked run as `result` or `invalidResult`.

## Nudge and reply

- `nudge`: `herdr agent send-keys <pane> esc`, then `herdr agent prompt <pane> continue`. Errors are logged; the dispatcher flags `stale` after the grace anyway.
- `reply`: `herdr agent prompt <pane> <text>`. `Herdr.prompt` joins lines with spaces, since herdr rejects newlines. On error (`agent_blocked` while a dialog is open) the worker sends `replyFailed`.

Tracking lives in memory only; after a restart the dispatcher re-sends `watch` (see `claims-and-lifecycle.md`).
