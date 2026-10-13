# Journal and markers

What sapphire-agent stores locally and why, and how markers on its comments and notices make every write safe to repeat.

## Reality first

Linear, T3, git and GitHub are the source of truth. Every tick observes them again, so state that can be observed is never stored: the epic's state and labels, the thread and its agent, the worktree, the PR, its threads and comments. The journal holds only what cannot be observed: timers, the parsed result file, the ids that tie a run to its T3 thread and session, a handoff's progress, which mentions were handled, what `sapphire` asked for, the projects, and the notices waiting to be posted.

Idempotency comes from markers on external writes: before a write, look for its marker (or its effect) and skip it when present. Notices get a second guard: the journal's outbox is unique on the marker, so a notice is written there once, and its Linear comment carries the marker too.

## The journal

SQLite through `@effect/sql-sqlite-node` (the built-in `node:sqlite`), with its migrator. Rows are typed with Effect `Schema`; there is no ORM. The file is `journal.db` in the state directory (`config.md`; live: `~/.local/state/sapphire-agent/journal.db`). Tests use `':memory:'` or a temp file. Columns are snake_case in SQLite and camelCase in code. Times are epoch milliseconds.

### `runs`

One row per epic (`epic_id` is the primary key); a new claim replaces the old row.

| Column | What and why |
| --- | --- |
| `epic_id`, `identifier`, `team_id` | Which epic, for lookups, log annotations and flags. |
| `status` | `claimed`, `running`, `stale`, `error`, `ended`, `kept` (see `rules.md`). |
| `job` | JSON: `{ "_tag": "orchestrate" }` or `{ "_tag": "follow-up", "threadIds": [...], "instruction": "..." or null }`. What a follow-up was asked for; the threads stay unresolved on GitHub until it is posted. |
| `repo`, `branch` | The local clone and the epic's branch, so cleanup finds the worktree and PR even once the epic is gone from the ready list. |
| `worktree_path` | Set once the worktree exists. |
| `thread_id`, `thread_run_id` | The run's thread and the run of it the start launched, recorded right after the launch (before the epic moves), so a restart waits on it and never launches another; a handoff moves them to the next thread, and a send or nudge that starts a turn to its run. Null until the launch. `worktree_path` is T3's worktree, recorded once T3 made it. |
| `thread_settled_at` | When cleanup settled the run's thread, or found T3 had. A thread found un-settled after that was un-settled by the user, so cleanup leaves it alone. |
| `session` | JSON `{ "id": "<uuid>", "name": "<identifier lowercased>" }`: the Claude session, named at the claim. T3 chooses the session its thread's agent runs in, so the agent event server replaces the id with the session of the run's first hook event, and with any later one (`rules.md`, Agent events). Other Claude sessions message the agent by its name. Null for a run claimed before sessions were recorded. |
| `reply_to` | The Claude session that asked for the run (`sapphire dispatch --reply-to`), taken from the newest `start` request at the claim. The prompt names it and the agent asks it its questions. Null: the agent asks on Linear. |
| `claimed_at` | Claim time. Keys most markers, starts the wall-clock cap and the start timeout. |
| `started_at` | When the run's T3 thread was launched. Decides the run's states and whether it ever started. |
| `agent_status`, `agent_status_since` | Last observed agent status (`working`, `idle`, or `blocked` while a question or approval waits) and when the thread, its timeline, its subagents or the agent's hook events last showed progress: the stale timer. |
| `nudged_at` | When the current stale episode's nudge was sent, which keys it, so a restart or a later tick sends only that nudge again. |
| `result` | The parsed result file, stored before anything is posted, so posting resumes after a crash even if the file is gone. |
| `handoff` | JSON `{ "sessionId": "<uuid>", "step": "requested" \| "resumed" }`: the latest handoff of the run's agent, each step recorded before it is sent (`rules.md`, Handoff). Null before the first. |

### `transient_failures`

`epic_id` and `first_seen_at`: when the epic's current streak of Transient failures started. Recorded on every Transient failure of the epic's work (keeping the first time), cleared on its next success. It drives the `transientFailure` notice after `flagTransientAfterSeconds` and keys its marker (`failure-policy.md`).

### `commands`

One row per comment that mentioned the bot, written by the webhook server before it answers the delivery and before anything else happens for it, so a comment is handled at most once. `id` numbers them (`CMD-<id>`); `comment_id` (the comment's GitHub node id, the delivery's `node_id`) is unique, and recording a comment again does nothing, so a duplicated or redelivered delivery starts no second run.

| Column | What and why |
| --- | --- |
| `comment_id`, `url`, `author`, `body` | The comment: what the agent is asked, and which comment its replies answer. |
| `repo`, `number` | The issue or PR it is on, as `owner/name` and number. |
| `status` | `ignored`, `queued`, `claimed`, `running`, `ended`, `error` (see `rules.md`). |
| `cwd` | The checkout the agent runs in, once made. |
| `thread_id` | The command's T3 thread, recorded right after the launch. |
| `recorded_at`, `claimed_at`, `started_at` | When the comment was recorded, when its turn came (keys its `commandFailed` marker, starts the start timeout and the cap) and when its thread was launched. |
| `acknowledged_at` | When the comment got the App's thumbs-up; null until then, and for ignored commands. Adding a reaction twice changes nothing on GitHub, so a crash before this is written only repeats the call. |

### `requests`

What `sapphire` asked for (`id`, `request` JSON, `created_at`): `start` (by `sapphire dispatch`, with the session to reply to, or none), `stop`, `send`, `follow-up` (by epic identifier), `reply` and `done` (by command id), `project-add` and `project-edit` (with the project's settings) and `project-remove` (by team), plus the `session` changes and `handoff`s (by session) the agent event server saw (by epic identifier). Both only append rows, so it never overwrites a row a rule is updating; the rule that acts on a request deletes it. `id` is never handed out again (AUTOINCREMENT), since a reply's marker is keyed by it.

### `projects`

One row per project (`team` the exact Linear team name, primary key; `repo`; `label_repos_directory` or null). Written only by the `Projects` service: the import of config `teams` into an empty table at startup, and the requests rule applying `sapphire project` requests (`config.md`, Projects).

### `notices`

The outbox of notices for the Linear epics (`id` AUTOINCREMENT, `identifier`, `purpose`, `key`, `text` in markdown, `created_at`, `sent_at`), unique on (`identifier`, `purpose`, `key`), the notice's marker: adding one whose marker exists does nothing. Sent rows stay, so a notice written again for the same marker is never posted again. The notices rule posts the unsent ones on their epics, oldest first, and sets `sent_at` (`rules.md`, Notices).

### `subagent_handoffs`

`agent_id` (primary key), `identifier`, `requested_at`: the subagents told to hand off, so each is told once (`rules.md`, Handoff).

### `t3_projects`

`repo` (primary key, a team repo or a label repo), `project_id`: the T3 project `T3Projects` found or created for it, so it is created once.

### `epic_snapshots`

`epic_id` (primary key), `claimed_at` (the claim of the run it was taken for), `taken_at` (when Linear was read for it), `issues` (JSON: the epic, then its sub-issues, each with id, identifier, title, description, state name and sorted label names and blocker identifiers), `edits` (JSON: the edits by others not yet sent, each with the issue, the field and the text before and after; null while there are none), `edited_at` (when they last changed). Written by the epic-edits rule (`rules.md`); deleted once the run is no longer in flight.

### Migrations

`0001_create_journal` (runs, transient failures, commands, mention tables since dropped, requests), `0002_drop_mention_threads`, `0003_create_delivery_mark`, `0004_add_sessions`, `0005_add_reply_to`, `0006_add_command_acknowledged_at`, `0007_create_chat_sessions`, `0008_create_topics` (and `archive_thread`), `0009_create_projects`, `0010_add_chat_session_cwd_and_thread` (rebuilds `chat_sessions`; earlier rows get the home directory, no thread and kind `turn`), `0011_create_notices` (and drops `runs.question_comment_id` and `runs.delivered_reply_ids`), `0012_add_handoffs` (`runs.handoff`, `subagent_handoffs`), `0013_drop_chat` (drops `chat_sessions`, `topics`, `archive_thread`, `delivery_mark` and `projects.thread`, deletes pending `phase` requests, and marks the unsent `CMD-<n>` notices sent), `0014_create_t3_projects`, `0015_add_threads` (`runs.thread_id`, `runs.thread_run_id`), `0016_add_thread_settling_and_command_threads` (`runs.thread_settled_at`, `commands.thread_id`), `0017_drop_tabs` (drops `runs.tab_id`, `pane_id` and `tail_hash` and `commands.tab_id`, `pane_id`, `session`, `agent_status`, `agent_status_since`, `nudged_at` and `tail_hash`; turns `awaitingInput` runs into `running`, clears an `agent_status` other than `working`, `idle` or `blocked` and a handoff at step `cleared`, and marks the unsent `awaitingInput`, `error` and `workingOrphan` notices sent), `0018_create_epic_snapshots`. They run at startup, in the service and the CLI alike.

### Journal service

`getRun`, `listRuns` (ordered by claim time), `putRun` (insert or replace), `deleteRun`, `recordTransient` (returns the streak start), `clearTransient`; `listCommands`, `addCommand` (a no-op for a comment recorded already), `putCommand`; `addRequest`, `listRequests`, `deleteRequest`, `claimRun` (records the claim and drops its requests in one transaction); `listProjects`, `putProjects` (one transaction), `deleteProject`; `addNotice` (a no-op, returning false, for a marker it has), `hasNotice`, `unsentNotices`, `markNoticeSent`; `addSubagentHandoff` (false when told already); `getT3Project`, `listT3Projects`, `putT3Project` (insert or replace). Rules read the journal when they plan, so each sees what the rules before it wrote this tick.

The CLI (`src/ctl.ts`, behind `scripts/ctl.sh`) opens the same file while the service runs. SQLite runs in WAL mode with a 5 s busy timeout (the client's defaults), so its reads never block the service and its few writes wait for the service's. `sapphire status` prints whether dispatching is paused, the projects, the runs (identifier, status, job, the epic's Linear state, claim time, T3 thread, session, worktree), the commands in flight and the requests waiting.

## Markers

A marker names one write: the epic's identifier, or the command's (`CMD-<n>`), a purpose (`MarkerPurpose` in `markers.ts`) and a key. Every comment sapphire-agent writes, on Linear or on GitHub, ends with it, hidden, on a line of its own:

```
<!-- sapphire-agent:<IDENTIFIER>:<purpose>:<key> -->
```

The key is URI-encoded. A marker inside a quote (`> <!-- ... -->`) does not count, so a user quoting one of our comments is not mistaken for it. A notice's marker is its key in the outbox and ends its comment on the epic. Purpose and key together name one write: a retry or restart finds it and skips, while a later occurrence (a new stall in the same run, a new summary from a follow-up run) has a new key and is written. The `Comments` service builds every body and key; `claimedAt` is the run's claim time.

On the Linear epic:

| Purpose | Key | Posted |
| --- | --- | --- |
| `pullRequestOpened` | `<url>` | Once per PR, `PR opened: <url>`, by the results rule. |

On the GitHub PR, as the GitHub App:

| Purpose | Key | Posted |
| --- | --- | --- |
| `reply` | `<threadId>.<claimedAt>` | Once per thread per run, among the thread's comments. |
| `addressed` | `<claimedAt>` | Once per run that replied to threads, `Addressed your concerns inline.`, among the PR's newest 100 comments. |

On the issue or PR of a command's comment, as the GitHub App, among its newest 100 comments:

| Purpose | Key | Posted |
| --- | --- | --- |
| `commandReply` | `<requestId>` | Once per `sapphire reply`. |
| `commandFailed` | `<claimedAt>` of the command | Once per failed command. |

Notices, in the journal's outbox (`notices`), then posted as comments on the Linear epic (`rules.md`, Notices):

| Purpose | Key | Sent |
| --- | --- | --- |
| `stale` | `<claimedAt>-<nudgedAt>` | Once per nudged episode of a run. |
| `startFailed`, `invalidResult`, `noPullRequest`, `threadMismatch`, `overCap`, `permanentFailure` | `<claimedAt>` | Once per run (`permanentFailure` without a run: once per failure streak). |
| `summary`, `flags` | `<claimedAt>` | Once per run that posted its result; `flags` only with unfixed flags. |
| `keptWorktree` | `<claimedAt>`, or the worktree path for an orphan | Once per run or orphan worktree. |
| `transientFailure` | `<streakStartedAt>` | Once per streak of transient failures. |
| `handoffMissing` | `<sessionId>` | Once per run session that wrote no handoff doc in time. |
| `subagentOverContext` | `<agentId>` | Once per subagent still going at 1.2 times `handoffAtTokens` after it was told to hand off. |

Writes without a marker are idempotent by their effect: a move is skipped when the epic is already in that state, a label is added only if missing, a thumbs-up only once per comment (GitHub keeps one of each kind per user), a thread is resolved only if unresolved, settling a settled thread changes nothing, and worktree removal skips what is already gone.

## Crash safety

Every multi-step action is ordered so that a crash at any step leaves something the next tick finishes, without posting twice or skipping a step:

- Claim before start; record the launched thread, then move the epic and record `running`. A thread launched just before a crash is found by its title and not launched again. Commands start the same way.
- A claim and the drop of its requests (a follow-up's, or an epic's `start` requests) are one transaction.
- A webhook delivery is answered 2xx only after its command is recorded, so a crash or a journal error leaves it failed in the App's delivery log, where it can be redelivered by hand; a command is keyed by its comment, so a redelivery records nothing twice.
- A reply or a failure of a command is posted on GitHub before its request is dropped or the command is recorded `error`, and its marker keeps it to one.
- Store the result before posting it; post each part only when its marker is missing; remove the label, move the epic, and only then mark the run `ended`.
- Flags put the label on first, then the notice, then the run update.
- A notice is posted on the epic, then marked sent; a crash in between finds its marker on the epic next tick and only marks it sent.
- A handoff step is recorded on the run, then sent; the `handoff` request is dropped only once the send landed, so a crash or a failed send sends it again on a later tick, under a `clientRequestId` T3 dedupes. A thread launched for it just before a crash is found by its title.
- Cleanup settles the thread, removes the worktree and branch, and only then drops the row.

`src/lifecycle.test.ts` proves it: it runs one epic through dispatch, a question waiting in the agent's thread and answered there, results, a mention whose command asks for a follow-up, the follow-up and cleanup, and repeats that with a crash injected at every journal, Linear and GitHub write, asserting the same end state and no double posts (`development.md`).
