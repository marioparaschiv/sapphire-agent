# Architecture

How the dispatcher and worker are split, the messages between them, how `main.ts` wires them in one process, and where a remote worker would plug in.

## Two roles

| | Dispatcher (`src/dispatcher.ts`) | Worker (`src/worker.ts`) |
| --- | --- | --- |
| Talks to | Linear, `gh`, `claims.json`, pause file | git, herdr CLI and socket, `~/.claude.json` |
| Owns | Claims, Linear state moves, comments, labels, PR checks | Worktrees, tabs, starting Claude, watching agent status |
| Concurrency | Every tick and every worker message runs through one promise queue (`serial`, `dispatcher.ts:131-137`) | Reconciles of tracked runs run one at a time (`worker.ts:182-190`); dispatches can overlap |
| State | `claims.json` (durable) | In-memory `runs` map only |

The worker never talks to Linear and the dispatcher never talks to herdr.

## Protocol (`src/protocol.ts`)

Plain JSON, validated with zod on receipt. Shared shapes:

- `Job`: `epicId, identifier, branch, repoPath, tabLabel, prompt`.
- `Run`: `tabId, paneId, worktreePath, branch, githubRepo`.
- `AgentStatus`: `working | idle | done | blocked | unknown` (herdr's values).

Dispatcher to worker:

| Message | Meaning |
| --- | --- |
| `dispatch { job }` | Start a new run. |
| `watch { job, run? }` | Re-attach after a dispatcher restart. With `run`: track that pane. Without: find the tab by label ("adopt"). |

Worker to dispatcher:

| Message | Meaning |
| --- | --- |
| `started { epicId, run }` | Claude is confirmed running in the pane. |
| `status { epicId, status, tail }` | Agent status changed. `tail` is the last pane lines (empty while `working`). |
| `finished { epicId, reason, tail }` | `exited` (pane alive, Claude gone) or `vanished` (pane gone). Worker stops tracking. |
| `failed { epicId, error, tail? }` | The run could not start or be adopted. |

## In-process link (`src/main.ts`)

- Parses env with zod (`main.ts:14-23`), loads config, reads the API key (`main.ts:26-42`).
- Worker `send` parses with `workerMessageSchema` and calls `dispatcher.handle` (`main.ts:54`).
- Dispatcher `send` parses with `dispatcherMessageSchema` and calls `worker.handle` in a `queueMicrotask` (`main.ts:62`), so the worker runs outside the dispatcher's call stack. The claim is already saved before `send` (`dispatcher.ts:323-325`).
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
| `src/dispatcher.ts` | Poll, reconcile claims, dispatch, flag stuck/failed, build the prompt and comments. |
| `src/claims.ts` | `ClaimStore`: zod-validated `claims.json`, atomic save on every change. |
| `src/worker.ts` | Start runs, adopt after restart, track panes via events plus timer. |
| `src/herdr.ts` | herdr CLI wrapper and raw-socket event subscription. |
| `src/git.ts` | Worktree path layout, `prepareWorktree`, GitHub `owner/repo` from origin. |
| `src/trust.ts` | Pre-accept Claude's folder trust in `~/.claude.json`. |
| `src/linear.ts` | Linear GraphQL client. |
| `src/github.ts` | `findPullRequest` via `gh pr list`. |
| `src/config.ts` | Config schema, defaults, `~` expansion, `resolveRepo`. |
| `src/atomic-write.ts` | Temp file + fsync + rename, mode 600. |
| `src/fixtures/linear-server.ts` | Fake Linear GraphQL server for tests. |
| `src/*.test.ts` | Tests, see `development.md`. |
