# Journal and markers

Linear, T3, git and GitHub are the source of truth, observed again every tick: epic state and labels, thread and agent, worktree, PR, threads and comments are never stored. The journal holds only what cannot be observed. Every external write is made safe to repeat by a marker (or by checking its effect), and every multi-step action is ordered so a crash at any step is finished by the next tick without posting twice or skipping a step (the orders are in each rule, `rules.md`; `lifecycle.test.ts` proves it, `development.md`).

## The journal

SQLite via `@effect/sql-sqlite-node` (`node:sqlite`) and its migrator; rows typed with `Schema`, no ORM. `journal.db` in the state directory (live `~/.local/state/sapphire-agent/journal.db`). snake_case columns, camelCase in code, times in epoch ms. WAL mode, 5 s busy timeout (client defaults): the CLI opens the same file while the service runs, its reads never block and its few writes wait. Rules read it when they plan.

### `runs`

One row per epic (`epic_id` primary key); a new claim replaces it.

| Column | What and why |
| --- | --- |
| `status` | `rules.md`, Runs and statuses. |
| `job` | JSON `{ "_tag": "orchestrate" }` or `{ "_tag": "follow-up", "threadIds": [...], "instruction": "..." \| null }`. The threads stay unresolved on GitHub until posted. |
| `epic_id`, `identifier`, `team_id`, `repo`, `branch`, `worktree_path` | Kept so cleanup finds worktree and PR after the epic leaves the ready list; `worktree_path` once T3 made it. |
| `thread_id`, `thread_run_id` | Recorded right after launch, before the epic moves, so a restart waits on it and never relaunches. A handoff moves them to the new thread; a send or nudge that starts a turn moves `thread_run_id`. Null until launch. |
| `thread_settled_at` | When cleanup settled the thread or found T3 had. |
| `session` | JSON `{ "id": "<uuid>", "name": "<identifier lowercased>" }`, named at the claim. T3 picks the session, so the agent event server sets the id from the run's first hook event and any later one. Others message the agent by name. Null for runs claimed before sessions existed. |
| `reply_to` | Session that asked for the run (`--reply-to`), from the newest `start` request. Null: the agent asks on Linear. |
| `claimed_at` | Keys most markers; starts the wall-clock cap and start timeout. |
| `started_at` | Thread launch time; decides the run's states and whether it ever started. |
| `agent_status`, `agent_status_since` | `working`, `idle` or `blocked`, and last progress: the stale timer. |
| `nudged_at` | Keys the current episode's nudge, so only that one is re-sent. |
| `result` | Parsed result file, stored before posting, so posting resumes after a crash even if the file is gone. |
| `handoff` | JSON `{ "sessionId": "<uuid>", "step": "requested" \| "resumed" }`, latest handoff. Null before the first. |

### Other tables

- `transient_failures`: `epic_id`, `first_seen_at` of the epic's current Transient streak; set on failure (keeping the first time), cleared on success. Drives and keys `transientFailure` (`failure-policy.md`).
- `commands`: one row per comment mentioning the bot, written before the delivery is answered. `id` gives `CMD-<id>`; `comment_id` (GitHub node id) is unique, re-recording a no-op. Also `url`, `author`, `body`; `repo` (`owner/name`) and `number` of the issue or PR; `status` (`rules.md`, Commands); `cwd` (checkout); `thread_id`; `recorded_at`; `claimed_at` (keys `commandFailed`, starts start timeout and cap); `started_at`; `acknowledged_at` (thumbs-up; null until then and for ignored; reacting twice is harmless).
- `requests`: `id` AUTOINCREMENT (never reused: a reply's marker is keyed by it), `request` JSON, `created_at`. Kinds: `start` (with reply-to session or none), `stop`, `send`, `follow-up` (by epic), `reply`, `done` (by command), `project-add`/`-edit` (settings), `project-remove` (team), and from the agent event server `session` and `handoff` (by session, epic identifier). Writers only append; the acting rule deletes.
- `projects`: `team` (exact Linear name, primary key), `repo`, `label_repos_directory` or null. Written only by `Projects`.
- `notices`: outbox; `id` AUTOINCREMENT, `identifier`, `purpose`, `key`, `text` (markdown), `created_at`, `sent_at`; unique on (`identifier`, `purpose`, `key`), so adding a known marker does nothing and sent rows block reposts.
- `subagent_handoffs`: `agent_id` (primary key), `identifier`, `requested_at`: each subagent told once.
- `t3_projects`: `repo` (primary key), `project_id`: created once.

### Migrations

In `journal.ts`, run at startup by service and CLI alike: `0001_create_journal`, `0002_drop_mention_threads`, `0003_create_delivery_mark`, `0004_add_sessions`, `0005_add_reply_to`, `0006_add_command_acknowledged_at`, `0007_create_chat_sessions`, `0008_create_topics`, `0009_create_projects`, `0010_add_chat_session_cwd_and_thread`, `0011_create_notices`, `0012_add_handoffs`, `0013_drop_chat`, `0014_create_t3_projects`, `0015_add_threads`, `0016_add_thread_settling_and_command_threads`, `0017_drop_tabs`. Data they change: 0013 deletes pending `phase` requests and marks unsent `CMD-<n>` notices sent; 0017 turns `awaitingInput` runs into `running`, clears an `agent_status` other than `working`/`idle`/`blocked` and a handoff at step `cleared`, and marks unsent `awaitingInput`, `error`, `workingOrphan` notices sent.

### API

`getRun`, `listRuns` (by claim time), `putRun` (insert or replace), `deleteRun`, `recordTransient` (returns streak start), `clearTransient`; `listCommands`, `addCommand` (no-op if recorded), `putCommand`; `addRequest`, `listRequests`, `deleteRequest`, `claimRun` (claim plus dropping its requests, one transaction); `listProjects`, `putProjects` (one transaction), `deleteProject`; `addNotice` (false if the marker exists), `hasNotice`, `unsentNotices`, `markNoticeSent`; `addSubagentHandoff` (false if told); `getT3Project`, `listT3Projects`, `putT3Project`.

## Markers

Every comment the service writes, on Linear or GitHub, ends with a hidden marker on its own line:

```
<!-- sapphire-agent:<IDENTIFIER>:<purpose>:<key> -->
```

`<IDENTIFIER>` is the epic's or the command's (`CMD-<n>`); purpose is `MarkerPurpose` (`markers.ts`); the key is URI-encoded. A marker inside a quote (`> <!-- ... -->`) does not count. A retry finds it and skips; a later occurrence (new stall, new follow-up summary) has a new key. `Comments` builds every body and key; `claimedAt` is the run's claim time.

| Purpose | Key | Where, how often |
| --- | --- | --- |
| `pullRequestOpened` | `<url>` | Linear epic, once per PR. |
| `reply` | `<threadId>.<claimedAt>` | PR thread, once per thread per run (looked for among the thread's comments). |
| `addressed` | `<claimedAt>` | PR, once per run that replied (among its newest 100 comments). |
| `commandReply` | `<requestId>` | Command comment's issue or PR, once per `sapphire reply` (newest 100). |
| `commandFailed` | command's `<claimedAt>` | Same, once per failed command. |
| `stale` | `<claimedAt>-<nudgedAt>` | Notice, once per nudged episode. |
| `startFailed`, `invalidResult`, `noPullRequest`, `threadMismatch`, `overCap`, `permanentFailure` | `<claimedAt>` | Notice, once per run (`permanentFailure` without a run: per failure streak). |
| `summary`, `flags` | `<claimedAt>` | Notice, once per run that posted; `flags` only with unfixed flags. |
| `keptWorktree` | `<claimedAt>`, or the path for an orphan | Notice, once per run or orphan. |
| `transientFailure` | `<streakStartedAt>` | Notice, once per streak. |
| `handoffMissing` | `<sessionId>` | Notice, once per session with no doc in time. |
| `subagentOverContext` | `<agentId>` | Notice, once per subagent past 1.2x `handoffAtTokens`. |

Notices are guarded twice: the outbox is unique on the marker, and the posted comment carries it.

Writes without a marker are idempotent by effect: a move is skipped when already there, a label added only if missing, a thumbs-up once per comment (GitHub keeps one per kind per user), a thread resolved only if unresolved, settling a settled thread changes nothing, worktree removal skips what is gone, and T3 sends, interrupts and handoffs carry a `clientRequestId` T3 dedupes.
