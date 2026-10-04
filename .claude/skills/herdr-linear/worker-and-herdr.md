# Worker and herdr

How the worker starts a Claude Code run (worktree, trust, tab, `herdr agent start`) and how it watches the agent afterwards.

## Dispatch sequence (`worker.ts:79-110`)

1. `prepareWorktree(repoPath, branch, worktreesDirectory)`.
2. `githubRepo(repoPath)`: `owner/repo` from `origin` (must be GitHub).
3. `trustFolder(~/.claude.json, worktree)`.
4. `openTab(tabLabel, worktree)`.
5. `herdr agent start`, then confirm with `herdr agent get`.
6. Send `started { run }` and begin tracking.

Any throw becomes a `failed` message (`worker.ts:69-76`). Errors after the tab exists carry the last 40 pane lines.

## Worktrees (`src/git.ts`)

- Path: `<worktreesDirectory>/<basename(repoPath)>/<branch with [^A-Za-z0-9._-]+ replaced by ->`, e.g. `~/.herdr/worktrees/unbound/mario-unb-12-settings-sync`. Same layout as herdr's own worktrees.
- Always `git fetch origin` first.
- Path exists: reuse it if it has the same branch checked out, else throw.
- Local branch exists: `git worktree add <path> <branch>`.
- Only on origin: `worktree add --track -b <branch> <path> origin/<branch>`.
- New: `worktree add --no-track -b <branch> <path> <origin default>`, so a plain `git push` never targets the default branch. Default comes from `origin/HEAD`, set with `remote set-head --auto` if missing.

Done in git directly rather than `herdr worktree create`, which creates and opens its own workspace; this code needs a tab in the shared `agents` workspace plus the reuse and no-track rules above.

## Trust pre-accept (`src/trust.ts`)

- Sets `projects[<worktree>].hasTrustDialogAccepted = true` in `~/.claude.json` (override: `CLAUDE_CONFIG_PATH`), so Claude does not stop at the trust dialog.
- Writes a backup to `~/.claude.json.herdr-linear.bak` first.
- Optimistic: re-reads before writing and retries up to 5 times if Claude changed the file meanwhile, then throws.
- Unparseable JSON throws instead of overwriting.

## Tabs (`worker.ts:112-126`, `herdr.ts:84-109`)

- Looks for a workspace labelled `workspaceLabel` (default `agents`).
- Found: `herdr tab create --workspace <id> --label <tabLabel> --cwd <worktree> --env HERDR_BLANK=1 --no-focus`.
- Missing: `herdr workspace create --label agents ...` with the same flags, then `tab rename` to the tab label.
- `HERDR_BLANK=1` makes the pane shell skip its automatic Claude launch, so `agent start` gets a plain prompt.
- Tab label: `<IDENTIFIER> <title, cut to 40 chars with an ellipsis>` (`dispatcher.ts:333`). Adopt finds tabs by this exact label.

## `herdr agent start` quirks (`herdr.ts:144-148`, `worker.ts:90-104`)

Command: `herdr agent start <identifier lowercased> --kind claude --pane <pane> --timeout 30000 -- <prompt>`.

- It returns only when the agent is ready for input, which with an initial prompt means after that prompt's whole turn. So it nearly always times out.
- A `HerdrError` with code `timeout` is treated as "still starting". Any other error fails the run.
- Then `herdr agent get <pane>` must show `agent: claude` with status other than `blocked`; otherwise `failed` with the pane tail.
- The prompt must be one line. herdr refuses to pass newlines to the shell (`dispatcher.ts:335`).

## CLI wrapper (`src/herdr.ts`)

- Every call is `execFile($HERDR_BIN_PATH, args)`; JSON stdout is `{ result }`, parsed with zod.
- Errors: stderr JSON `{ error: { code, message } }` becomes `HerdrError(code)`.
- `pane_not_found` / `agent_not_found` map to `undefined` in `pane()` and `agent()`.
- `readPane` uses `--source recent-unwrapped` and squeezes blank-line runs.

## Watching a run (`worker.ts:41-48, 152-225`)

- Events: raw socket at `$HERDR_SOCKET_PATH`, `events.subscribe` for `pane.agent_status_changed`, `pane.agent_detected`, `pane.exited`, `pane.closed`, each filtered by `pane_id` (subscriptions need it).
- Events only trigger a reconcile; their payload is ignored.
- Events are not durable and closing a pane emits nothing (`pane.closed` is subscribed but not relied on), so every tracked run is also reconciled every `pollSeconds`.
- On socket close the worker resubscribes after `pollSeconds`.
- Reconcile: pane gone gives `finished vanished`; pane alive but no Claude gives `finished exited` with tail; status change gives `status` (tail only when not `working`).

Tracking lives in memory only; after a restart the dispatcher re-sends `watch` (see `claims-and-lifecycle.md`).
