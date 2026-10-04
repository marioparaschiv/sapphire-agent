# Architecture

How the dispatcher and worker are split, the messages between them, how `main.ts` wires them in one process, and where a remote worker would plug in.

## Two roles

| | Dispatcher (`src/dispatcher.ts`) | Worker (`src/worker.ts`) |
| --- | --- | --- |
| Talks to | Linear, `gh` (reads and every GitHub write), `claims.json`, pause file | git, herdr CLI and socket, `~/.claude.json`, the run's result file |
| Owns | Claims, Linear state moves, comments, labels, PR checks, posting results to PRs, stale/cap timing | Worktrees, tabs, starting Claude, watching agent status and pane tail, reading the result file, nudging, typing replies, closing tabs, removing worktrees |
| Concurrency | Every tick and every worker message runs through one promise queue (`serial`, `dispatcher.ts:211-217`) | Reconciles of tracked runs run one at a time; starts and cleanups share another queue (`serial`) |
| State | `claims.json` (durable) | In-memory `runs` map only |

The worker never talks to Linear and the dispatcher never talks to herdr.

## Protocol (`src/protocol.ts`)

Plain JSON, validated with zod on receipt. Shared shapes:

- `Job`: `epicId, identifier, branch, repoPath, tabLabel, prompt, threadIds?`. `threadIds` marks a follow-up run: the pending review threads it answers. The worker pulls the branch before starting it.
- `Run`: `tabId, paneId, worktreePath, branch, githubRepo`.
- `AgentStatus`: `working | idle | done | blocked | unknown` (herdr's values).
- `ResultFile`: `summary, replies[{ threadId, body }], flags[{ path, line, body }]` (`resultFileSchema`, the only definition).

Dispatcher to worker:

| Message | Meaning |
| --- | --- |
| `dispatch { job }` | Start a new run (initial or follow-up). |
| `watch { job, run? }` | Re-attach after a dispatcher restart. With `run`: track that pane. Without: find the tab by label ("adopt"). |
| `close { job, run }` | The run ended: stop tracking it and close its tab. |
| `cleanup { job, run }` | Epic shipped or PR merged/closed: close the tab, remove the worktree and local branch unless they hold unpushed work. |
| `nudge { job, run }` | Stale run: `send-keys esc`, then prompt `continue`. |
| `reply { job, run, commentId, text }` | Type the user's Linear reply into the pane with `herdr agent prompt`. |

Worker to dispatcher:

| Message | Meaning |
| --- | --- |
| `started { epicId, run }` | Claude is confirmed running in the pane. |
| `status { epicId, status, tail }` | Agent status or pane tail changed. `tail` is the last 40 pane lines, also while `working`. |
| `finished { epicId, reason, tail }` | `exited` (pane alive, Claude gone) or `vanished` (pane gone). Worker stops tracking. |
| `failed { epicId, error, tail? }` | The run could not start or be adopted. |
| `cleaned { epicId }` | Worktree and branch are gone (or already were). |
| `kept { epicId, worktreePath, reason }` | Worktree kept: `uncommitted changes` or `N unpushed commits`. |
| `result { epicId, result }` | The agent wrote a valid result file. Sent once per tracked run (again after a re-`watch`). |
| `invalidResult { epicId, error }` | The result file is not JSON or fails the schema; `error` is `z.prettifyError` output. |
| `replyFailed { epicId, commentId, error }` | `herdr agent prompt` refused the reply (e.g. `agent_blocked`). |

## In-process link (`src/main.ts`)

- Parses env with zod (`main.ts:14-23`), loads config, reads the API key (`main.ts:26-42`).
- Worker `send` parses with `workerMessageSchema` and calls `dispatcher.handle` (`main.ts:54`).
- Dispatcher `send` parses with `dispatcherMessageSchema` and calls `worker.handle` in a `queueMicrotask` (`main.ts:62`), so the worker runs outside the dispatcher's call stack. The claim is already saved before `send`.
- Startup order: `worker.start()` (reconcile timer), `dispatcher.start()` (send `watch` for in-flight claims), one `tick()`, then `setInterval(tick, pollSeconds)` (`main.ts:73-76`).
- Pause is a file: `$HERDR_PLUGIN_STATE_DIR/paused` (`main.ts:45, 64-67`).

## Remote worker seam

Both sides already exchange only `DispatcherMessage` / `WorkerMessage` through a `Send<T>` callback and validate what they receive. A remote worker means:

- Replace the two `send` closures in `main.ts` with a WebSocket transport (JSON per message).
- Run a second entry point on the remote machine that constructs `Worker` with its own `Herdr`, paths and `send`.
- Nothing in `dispatcher.ts` or `worker.ts` needs to change. Not built yet.

Note: `Run.worktreePath` and `Job.repoPath` are paths on the worker's machine.

## File map

| File | Role |
| --- | --- |
| `src/main.ts` | Entry point: env, config, key, wiring, timers. |
| `src/protocol.ts` | zod schemas for `Job`, `Run`, and all messages. |
| `src/dispatcher.ts` | Poll, reconcile claims, dispatch initial and follow-up runs, flag runs, post results, decide cleanup, build the prompt and comments. |
| `src/claims.ts` | `ClaimStore`: zod-validated `claims.json`, atomic save on every change. |
| `src/worker.ts` | Start runs, adopt after restart, track panes via events plus timer, close tabs, clean up worktrees. |
| `src/herdr.ts` | herdr CLI wrapper and raw-socket event subscription. |
| `src/git.ts` | Worktree path layout, `prepareWorktree`, `pullBranch`, `unsavedWork`, `removeWorktree`, GitHub `owner/repo` from origin, result file path and read. |
| `src/trust.ts` | Pre-accept Claude's folder trust in `~/.claude.json`. |
| `src/linear.ts` | Linear GraphQL client. |
| `src/github.ts` | `GitHub` class over the `gh` CLI: `findPullRequest`, `pendingThreads` (the pending rule), summary comment, flags review, thread reply and resolve; the onBehalfOf block. |
| `src/config.ts` | Config schema, defaults, `~` expansion, `resolveRepo`. |
| `src/atomic-write.ts` | Temp file + fsync + rename, mode 600. |
| `src/fixtures/linear-server.ts` | Fake Linear GraphQL server for tests. |
| `src/*.test.ts` | Tests, see `development.md`. |
