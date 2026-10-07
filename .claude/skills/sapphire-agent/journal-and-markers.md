# Journal and markers

What sapphire-agent stores locally and why, and how markers on its comments and notices make every write safe to repeat.

## Reality first

Linear, herdr, git and GitHub are the source of truth. Every tick observes them again, so state that can be observed is never stored: the epic's state and labels, the tab and its agent, the worktree, the PR, its threads and comments. The journal holds only what cannot be observed: timers, the last pane output hash, the parsed result file, the ids that tie a run to its tab and session, a handoff's progress, which mentions were handled, what `ctl.sh` asked for, how far back the App's webhook deliveries were checked, the projects, and the notices for the chat.

The Telegram bot's MTProto session and update state are not in the journal: mtcute keeps them in its own SQLite file, `$HERDR_PLUGIN_STATE_DIR/telegram.session` (`architecture.md`, The chat). Chat message text is never stored: the journal keeps only which Claude session (and directory) each bot message was written in, and the threads of epics and projects. Notice texts are kept, as the outbox.

Idempotency comes from markers on external writes: before a write, look for its marker (or its effect) and skip it when present. Notices are the exception: the journal's outbox is unique on the marker, and Telegram ignores a send keyed again.

## The journal

SQLite through `@effect/sql-sqlite-node` (the built-in `node:sqlite`), with its migrator. Rows are typed with Effect `Schema`; there is no ORM. The file is `$HERDR_PLUGIN_STATE_DIR/journal.db` (live: `~/.local/state/herdr/plugins/sapphire-agent/journal.db`). Tests use `':memory:'` or a temp file. Columns are snake_case in SQLite and camelCase in code. Times are epoch milliseconds.

### `runs`

One row per epic (`epic_id` is the primary key); a new claim replaces the old row.

| Column | What and why |
| --- | --- |
| `epic_id`, `identifier`, `team_id` | Which epic, for lookups, log annotations and flags. |
| `status` | `claimed`, `running`, `awaitingInput`, `stale`, `error`, `ended`, `kept` (see `rules.md`). |
| `job` | JSON: `{ "_tag": "orchestrate" }` or `{ "_tag": "follow-up", "threadIds": [...], "instruction": "..." or null }`. What a follow-up was asked for; the threads stay unresolved on GitHub until it is posted. |
| `repo`, `branch` | The local clone and the epic's branch, so cleanup finds the worktree and PR even once the epic is gone from the ready list. |
| `worktree_path` | Set once the worktree exists. |
| `tab_id`, `pane_id` | Set once the tab exists. Both must match herdr for the tab to count as the run's. |
| `session` | JSON `{ "id": "<uuid>", "name": "<identifier lowercased>" }`: the Claude session, made at the claim and kept, so a start after a crash uses the same one. Other Claude sessions message the agent by its name. Null for a run claimed before sessions were recorded, or adopted from an untracked tab Claude already ran in, whose session is unknown. A session the agent starts in the run's pane later (resume, clear, fork) replaces the id (`rules.md`, Agent events). |
| `reply_to` | The Claude session that asked for the run (`ctl.sh start --reply-to`), taken from the newest `start` request at the claim. The prompt names it and the agent asks it its questions. Null: the question is asked in the epic's thread (`rules.md`, Questions). |
| `claimed_at` | Claim time. Keys most markers, starts the wall-clock cap and the start timeout. |
| `started_at` | When Claude was confirmed started. Decides the run's states and whether it ever started. |
| `agent_status`, `agent_status_since` | Last observed agent status and when it or (while working) the output last changed: the awaitingInput and stale timers. |
| `nudged_at` | When the current stale episode's nudge was sent, so a restart does not nudge again. |
| `tail_hash` | Hash of the last pane output without tickers, to see whether the agent made progress. |
| `result` | The parsed result file, stored before anything is posted, so posting resumes after a crash even if the file is gone. |
| `handoff` | JSON `{ "sessionId": "<uuid>", "step": "requested" \| "cleared" \| "resumed" }`: the latest handoff of the run's agent, each step recorded before it is typed (`rules.md`, Handoff). Null before the first. |

### `transient_failures`

`epic_id` and `first_seen_at`: when the epic's current streak of Transient failures started. Recorded on every Transient failure of the epic's work (keeping the first time), cleared on its next success. It drives the `transientFailure` notice after `flagTransientAfterSeconds` and keys its marker (`failure-policy.md`).

### `commands`

One row per comment that mentioned the bot, written by the webhook server before it answers the delivery and before anything else happens for it, so a comment is handled at most once. `id` numbers them (`CMD-<id>`); `comment_id` (the comment's GitHub node id, the delivery's `node_id`) is unique, and recording a comment again does nothing, so a duplicated or redelivered delivery starts no second run.

| Column | What and why |
| --- | --- |
| `comment_id`, `url`, `author`, `body` | The comment: what the agent is asked, and which comment its notices answer. |
| `repo`, `number` | The issue or PR it is on, as `owner/name` and number. |
| `status` | `ignored`, `queued`, `claimed`, `running`, `ended`, `error` (see `rules.md`). |
| `cwd` | The directory the agent runs in, once found. |
| `tab_id`, `pane_id` | Set once the tab exists. |
| `session` | As for runs, named `cmd-<id>`; made when its turn comes. |
| `recorded_at`, `claimed_at`, `started_at` | When the comment was recorded, when its turn came (keys its `commandFailed` marker, starts the start timeout and the cap) and when Claude was confirmed started. |
| `agent_status`, `agent_status_since`, `nudged_at`, `tail_hash` | As for runs: the quiet and stale timers. |
| `acknowledged_at` | When the comment got the App's thumbs-up; null until then, and for ignored commands. Adding a reaction twice changes nothing on GitHub, so a crash before this is written only repeats the call. |

### `requests`

What `scripts/ctl.sh` asked for (`id`, `request` JSON, `created_at`): `start` (with the session to reply to, or none), `stop`, `send`, `follow-up` (by epic identifier), `reply` and `done` (by command id), `project-add` and `project-edit` (with the project's settings) and `project-remove` (by team), plus the `session` changes, `phase` starts (`sreview`, `review-verify`, `pr`) and `handoff`s (by session) the agent event server saw (by epic identifier); a chat message in an epic's thread is recorded as a `send`. Both only append rows, so it never overwrites a row a rule is updating; the rule that acts on a request deletes it. `id` is never handed out again (AUTOINCREMENT), since a reply's marker is keyed by it.

### `delivery_mark`

At most one row: `delivered_at` (ms), when the newest App webhook delivery the last complete scan saw was delivered. Every delivery listed before it either succeeded, has a later successful attempt of the same event, or was redelivered as a newer attempt. GitHub can list a slow attempt after a newer one was scanned; the next scan pages back to 10 minutes before the mark (and never more than 3 days, GitHub's retention). It is moved only after every redelivery request of the scan succeeded; without a row, a scan goes back the full 3 days (`rules.md`, Missed deliveries).

### `chat_sessions`

One row per bot message of a project's thread (rows of the main chat from before its manager have no thread) (`message_ref`, the platform's ref, e.g. `<chat id>:<message id>`), with the Claude `session_id` it was written in, the `cwd` that session ran in (Claude keeps sessions per directory, so a fork runs there too), its `thread`, its `kind` (`turn`, an answer, or `reminder`, the cache expiry reminder) and `created_at`. A reply to the message forks that session in that directory, and a project thread's newest row arms its reminder. Written once the reply is kept, so a reply cut short by a crash is not there and a reply to it gets the short explanation.

### `topics` and `archive_thread`

One row per epic with a chat thread (`epic_id`, `identifier`, `thread` the platform's ref, `state` it shows, `pull_request_url` posted, if any, `milestones` the slice milestones posted, as a JSON array of `<sub-issue id>:started|done`), written right after the thread is made and dropped right after it is deleted (`rules.md`, Topics). `archive_thread` holds at most one row: the `✅ Done` thread shipped epics are summed up in.

### `projects`

One row per project (`team` the exact Linear team name, primary key; `repo`; `label_repos_directory` or null; `thread`, its permanent chat thread, null until the project topics rule opens it). Written only by the `Projects` service: the import of config `teams` into an empty table at startup, and the requests rule applying `sapphire project` requests (`config.md`, Projects).

### `notices`

The outbox of messages for the chat (`id` AUTOINCREMENT, `identifier`, `purpose`, `key`, `text` in markdown, `created_at`, `sent_at`), unique on (`identifier`, `purpose`, `key`), the notice's marker: adding one whose marker exists does nothing. Sent rows stay, so a notice written again for the same marker is never sent again. The notices rule sends the unsent ones, oldest first, and sets `sent_at` (`rules.md`, Notices).

### `subagent_handoffs`

`agent_id` (primary key), `identifier`, `requested_at`: the subagents told to hand off, so each is told once (`rules.md`, Handoff).

### `manager_session`

At most one row (`id` 1): the main chat manager's `session_id`, which a start resumes, and the `summary` it started from (null for none), which a start uses when the session cannot be resumed. A rotation replaces the row with the next session and the outgoing one's summary before that session starts (`architecture.md`, the manager).

### Migrations

`0001_create_journal` (runs, transient failures, commands, mention tables since dropped, requests), `0002_drop_mention_threads`, `0003_create_delivery_mark`, `0004_add_sessions`, `0005_add_reply_to`, `0006_add_command_acknowledged_at`, `0007_create_chat_sessions`, `0008_create_topics` (and `archive_thread`), `0009_create_projects`, `0010_add_chat_session_cwd_and_thread` (rebuilds `chat_sessions`; earlier rows get the home directory, no thread and kind `turn`), `0011_create_notices` (and drops `runs.question_comment_id` and `runs.delivered_reply_ids`), `0012_add_handoffs` (`runs.handoff`, `subagent_handoffs`), `0013_create_manager_session`. They run at startup, in the service and the CLI alike.

### Journal service

`getRun`, `listRuns` (ordered by claim time), `putRun` (insert or replace), `deleteRun`, `recordTransient` (returns the streak start), `clearTransient`; `listCommands`, `addCommand` (a no-op for a comment recorded already), `putCommand`; `addRequest`, `listRequests`, `deleteRequest`, `claimRun` (records the claim and drops its requests in one transaction); `deliveryMark`, `setDeliveryMark`; `addChatSession` (the messages, with session, directory, thread and kind), `chatSession` (session and directory), `latestChatSession` (main chat only), `lastChatMessage` (a thread's newest); `listTopics`, `putTopic`, `deleteTopic`, `archiveThread`, `setArchiveThread`; `listProjects`, `putProjects` (one transaction), `deleteProject`; `addNotice` (a no-op, returning false, for a marker it has), `hasNotice`, `unsentNotices`, `markNoticeSent`; `addSubagentHandoff` (false when told already). Rules read the journal when they plan, so each sees what the rules before it wrote this tick.

The CLI (`src/ctl.ts`, behind `scripts/ctl.sh`) opens the same file while the service runs. SQLite runs in WAL mode with a 5 s busy timeout (the client's defaults), so its reads never block the service and its few writes wait for the service's. `ctl.sh status` prints the projects, the runs (identifier, status, job, the epic's Linear state, claim time, tab, session, worktree), the commands in flight and the requests waiting.

## Markers

A marker names one write: the epic's identifier, or the command's (`CMD-<n>`), a purpose (`MarkerPurpose` in `markers.ts`) and a key. Every comment sapphire-agent writes, on Linear or on GitHub, ends with it, hidden, on a line of its own:

```
<!-- sapphire-agent:<IDENTIFIER>:<purpose>:<key> -->
```

The key is URI-encoded. A marker inside a quote (`> <!-- ... -->`) does not count, so a user quoting one of our comments is not mistaken for it. A notice carries no visible marker: it is the notice's key in the outbox, and Telegram's `random_id` key is `notice:<IDENTIFIER>:<purpose>:<key>`. Purpose and key together name one write: a retry or restart finds it and skips, while a later occurrence (a new question in the same run, a new summary from a follow-up run) has a new key and is written. The `Comments` service builds every body and key; `claimedAt` is the run's claim time.

On the Linear epic:

| Purpose | Key | Posted |
| --- | --- | --- |
| `pullRequestOpened` | `<url>` | Once per PR, `PR opened: <url>`, by the topics or the results rule, whichever sees it first. |

On the GitHub PR, as the GitHub App:

| Purpose | Key | Posted |
| --- | --- | --- |
| `reply` | `<threadId>.<claimedAt>` | Once per thread per run, among the thread's comments. |
| `addressed` | `<claimedAt>` | Once per run that replied to threads, `Addressed your concerns inline.`, among the PR's newest 100 comments. |

Notices, in the journal's outbox (`notices`), sent to the chat (`rules.md`, Notices):

| Purpose | Key | Sent |
| --- | --- | --- |
| `awaitingInput` | `<claimedAt>-<agentStatusSince>` | Once per quiet episode of a run without an epic thread: the flag, or the question a run asked by message and got no reply to. |
| `stale` | `<claimedAt>-<nudgedAt>` | Once per nudged episode of a run. |
| `error`, `startFailed`, `invalidResult`, `noPullRequest`, `threadMismatch`, `overCap`, `permanentFailure` | `<claimedAt>` | Once per run (`permanentFailure` without a run: once per failure streak). |
| `summary`, `flags` | `<claimedAt>` | Once per run that posted its result; `flags` only with unfixed flags. |
| `keptWorktree` | `<claimedAt>`, or the worktree path for an orphan | Once per run or orphan worktree. |
| `transientFailure` | `<streakStartedAt>` | Once per streak of transient failures. |
| `workingOrphan` | `<tabId>` | Once per untracked tab whose agent is working. |
| `commandReply` | `<requestId>` | Once per `ctl.sh reply`. |
| `commandFailed` | `<claimedAt>` of the command | Once per failed command. |
| `handoffMissing` | `<sessionId>` | Once per run session that wrote no handoff doc in time. |
| `subagentOverContext` | `<agentId>` | Once per subagent still going at 1.2 times `handoffAtTokens` after it was told to hand off. |

Writes without a marker are idempotent by their effect: a move is skipped when the epic is already in that state, a label is added only if missing, a thumbs-up only once per comment (GitHub keeps one of each kind per user), a thread is resolved only if unresolved, a tab close of a missing tab is a no-op, and worktree removal skips what is already gone. Chat messages that are not notices are keyed by what they are for (`rules.md`, Topics).

## Crash safety

Every multi-step action is ordered so that a crash at any step leaves something the next tick finishes, without posting twice or skipping a step:

- Claim before start; record the worktree, then the tab, then `running`. An unrecorded tab is adopted, and Claude found in the pane is not started again. Commands start the same way.
- A claim and the drop of its requests (a follow-up's, or an epic's `start` requests) are one transaction.
- A webhook delivery is answered 2xx only after its command is recorded, so a crash or a journal error leaves it failed in the App's delivery log, and the next delivery scan redelivers it; a command is keyed by its comment, so a redelivery records nothing twice.
- The delivery scan requests every redelivery before it moves the delivery mark, so a crash mid-scan leaves the mark where it was and the next scan looks at the same deliveries again; a redelivery that already went through shows as a later success and is not repeated.
- A reply or a failure notice of a command is put in the outbox before its request is dropped or the command is recorded `error`, and its marker keeps it to one.
- Store the result before posting it; post each part only when its marker is missing; remove the label, move the epic, close the tab, and only then mark the run `ended`.
- Flags put the label on first, then the notice, then the run update.
- A notice is sent (keyed), then marked sent; a crash in between sends it again, which Telegram ignores.
- A handoff step is recorded on the run, then typed, so none is typed twice; a crash in between leaves it untyped (`rules.md`, Known limits).
- Cleanup closes the tab, removes the worktree and branch, and only then drops the row.
- A chat thread (an epic's, a project's or the archive) is made, then recorded; renamed, then its state recorded; its PR posted (keyed `random_id`s), then recorded; deleted, then its row dropped. A crash between making a thread and recording it leaves a stray one (`rules.md`, Known limits).

`src/lifecycle.test.ts` proves it: it runs one epic through dispatch, a question answered in its topic, results, a mention whose command asks for a follow-up, the follow-up and cleanup, and repeats that with a crash injected at every journal, Linear, GitHub, herdr and Telegram write, asserting the same end state and no double posts (`development.md`). The known exceptions are a `send` typed into the pane right before a crash, which is typed again, and a chat thread made right before a crash, which is left behind (`rules.md`).
