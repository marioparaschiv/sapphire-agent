# Journal and markers

What herdr-linear stores locally and why, and how markers on its comments make every write safe to repeat.

## Reality first

Linear, herdr, git and GitHub are the source of truth. Every tick observes them again, so state that can be observed is never stored: the epic's state and labels, the tab and its agent, the worktree, the PR, its threads and comments. The journal holds only what cannot be observed: timers, the last pane output hash, the parsed result file, the ids that tie a run to its tab and question, which mentions were handled, what `ctl.sh` asked for, and how far back the App's webhook deliveries were checked.

Idempotency comes from markers on external writes, not from the journal: before a write, look for its marker (or its effect) and skip it when present.

## The journal

SQLite through `@effect/sql-sqlite-node` (the built-in `node:sqlite`), with its migrator. Rows are typed with Effect `Schema`; there is no ORM. The file is `$HERDR_PLUGIN_STATE_DIR/journal.db` (live: `~/.local/state/herdr/plugins/herdr-linear/journal.db`). Tests use `':memory:'` or a temp file. Columns are snake_case in SQLite and camelCase in code. Times are epoch milliseconds.

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
| `claimed_at` | Claim time. Keys most markers, starts the wall-clock cap and the start timeout. |
| `started_at` | When Claude was confirmed started. Decides the run's states and whether it ever started. |
| `agent_status`, `agent_status_since` | Last observed agent status and when it or (while working) the output last changed: the awaitingInput and stale timers. |
| `nudged_at` | When the current stale episode's nudge was sent, so a restart does not nudge again. |
| `tail_hash` | Hash of the last pane output without tickers, to see whether the agent made progress. |
| `result` | The parsed result file, stored before anything is posted, so posting resumes after a crash even if the file is gone. |
| `question_comment_id` | The current awaitingInput question, whose replies are typed into the pane. |
| `delivered_reply_ids` | Replies already typed into the pane, so a crash before the delivery emoji is added never types one twice. |

### `transient_failures`

`epic_id` and `first_seen_at`: when the epic's current streak of Transient failures started. Recorded on every Transient failure of the epic's work (keeping the first time), cleared on its next success. It drives the `flagTransientAfterSeconds` flag and keys its marker (`failure-policy.md`).

### `commands`

One row per comment that mentioned the bot, written by the webhook server before it answers the delivery and before anything else happens for it, so a comment is handled at most once. `id` numbers them (`CMD-<id>`); `comment_id` (the comment's GitHub node id, the delivery's `node_id`) is unique, and recording a comment again does nothing, so a duplicated or redelivered delivery starts no second run.

| Column | What and why |
| --- | --- |
| `comment_id`, `url`, `author`, `body` | The comment: what the agent is asked, and where its replies go. |
| `repo`, `number` | The issue or PR it is on, as `owner/name` and number. |
| `status` | `ignored`, `queued`, `claimed`, `running`, `ended`, `error` (see `rules.md`). |
| `cwd` | The directory the agent runs in, once found. |
| `tab_id`, `pane_id` | Set once the tab exists. |
| `recorded_at`, `claimed_at`, `started_at` | When the comment was recorded, when its turn came (keys its `commandFailed` marker, starts the start timeout and the cap) and when Claude was confirmed started. |
| `agent_status`, `agent_status_since`, `nudged_at`, `tail_hash` | As for runs: the quiet and stale timers. |

### `requests`

What `scripts/ctl.sh` asked for (`id`, `request` JSON, `created_at`): `stop`, `send`, `follow-up` (by epic identifier), `reply` and `done` (by command id). The CLI only appends rows, so it never overwrites a row a rule is updating; the rule that acts on a request deletes it. `id` is never handed out again (AUTOINCREMENT), since a reply's marker is keyed by it.

### `delivery_mark`

At most one row: `delivered_at` (ms), when the newest App webhook delivery the last complete scan saw was delivered. Every delivery listed before it either succeeded, has a later successful attempt of the same event, or was redelivered as a newer attempt. GitHub can list a slow attempt after a newer one was scanned; the next scan pages back to 10 minutes before the mark (and never more than 3 days, GitHub's retention). It is moved only after every redelivery request of the scan succeeded; without a row, a scan goes back the full 3 days (`rules.md`, Missed deliveries).

### Journal service

`getRun`, `listRuns` (ordered by claim time), `putRun` (insert or replace), `deleteRun`, `recordTransient` (returns the streak start), `clearTransient`; `listCommands`, `addCommand` (a no-op for a comment recorded already), `putCommand`; `addRequest`, `listRequests`, `deleteRequest`, `claimFollowUp` (records the claim and drops its request in one transaction); `deliveryMark`, `setDeliveryMark`. Rules read the journal when they plan, so each sees what the rules before it wrote this tick.

The CLI (`src/ctl.ts`, behind `scripts/ctl.sh`) opens the same file while the service runs. SQLite runs in WAL mode with a 5 s busy timeout (the client's defaults), so its reads never block the service and its few writes wait for the service's. `ctl.sh status` prints the runs (identifier, status, job, the epic's Linear state, claim time, tab, worktree), the commands in flight and the requests waiting.

## Markers

Every comment herdr-linear writes, on Linear or on GitHub, ends with a hidden marker on a line of its own:

```
<!-- herdr-linear:<IDENTIFIER>:<purpose>:<key> -->
```

`<IDENTIFIER>` is the epic's, or the command's (`CMD-<n>`) for what the bot posts. The key is URI-encoded. A marker inside a quote (`> <!-- ... -->`) does not count, so a user quoting one of our comments is not mistaken for it. Purpose and key together name one comment: a retry or restart finds it and skips, while a later occurrence (a new question in the same run, a new summary from a follow-up run) has a new key and is posted. The `Comments` service builds every body and key; `claimedAt` is the run's claim time.

On the Linear epic:

| Purpose | Key | Posted |
| --- | --- | --- |
| `awaitingInput` | `<claimedAt>-<agentStatusSince>` | Once per quiet episode of a run. |
| `stale` | `<claimedAt>-<nudgedAt>` | Once per nudged episode of a run. |
| `error`, `startFailed`, `invalidResult`, `noPullRequest`, `threadMismatch`, `overCap`, `permanentFailure` | `<claimedAt>` | Once per run (`permanentFailure` without a run: once per failure streak). |
| `keptWorktree` | `<claimedAt>`, or the worktree path for an orphan | Once per run or orphan worktree. |
| `replyFailed` | The user's reply comment id | Once per refused reply, under the question. |
| `transientFailure` | `<streakStartedAt>` | Once per streak of transient failures. |
| `workingOrphan` | `<tabId>` | Once per untracked tab whose agent is working. |

On the GitHub PR, as the GitHub App:

| Purpose | Key | Posted |
| --- | --- | --- |
| `summary` | `<claimedAt>` | Once per run, as a PR comment. |
| `flags` | `<claimedAt>` | Once per run, as the COMMENT review holding every flag. |
| `reply` | `<threadId>.<claimedAt>` | Once per thread per run, among the thread's comments. |

On the issue or PR a command came from, as the GitHub App:

| Purpose | Key | Posted |
| --- | --- | --- |
| `commandReply` | `<requestId>` | Once per `ctl.sh reply`. |
| `commandFailed` | `<claimedAt>` of the command | Once per failed command. |

Writes without a marker are idempotent by their effect: a move is skipped when the epic is already in that state, a label is added only if missing, a reaction only if the comment lacks that emoji, a thread is resolved only if unresolved, a tab close of a missing tab is a no-op, and worktree removal skips what is already gone.

## Crash safety

Every multi-step action is ordered so that a crash at any step leaves something the next tick finishes, without posting twice or skipping a step:

- Claim before start; record the worktree, then the tab, then `running`. An unrecorded tab is adopted, and Claude found in the pane is not started again. Commands start the same way.
- A follow-up claim and the drop of its request are one transaction.
- A webhook delivery is answered 2xx only after its command is recorded, so a crash or a journal error leaves it failed in the App's delivery log, and the next delivery scan redelivers it; a command is keyed by its comment, so a redelivery records nothing twice.
- The delivery scan requests every redelivery before it moves the delivery mark, so a crash mid-scan leaves the mark where it was and the next scan looks at the same deliveries again; a redelivery that already went through shows as a later success and is not repeated.
- A reply or a failure notice of a command is posted before its request is dropped or the command is recorded `error`, and its marker keeps it to one.
- Store the result before posting it; post each part only when its marker is missing; remove the label, move the epic, close the tab, and only then mark the run `ended`.
- Flags put the label on first, then the comment, then the journal update.
- Cleanup closes the tab, removes the worktree and branch, and only then drops the row.

`src/lifecycle.test.ts` proves it: it runs one epic through dispatch, a relayed question, results, a mention whose command asks for a follow-up, the follow-up and cleanup, and repeats that with a crash injected at every journal, Linear, GitHub and herdr write, asserting the same end state and no double posts (`development.md`). The known exceptions are a question reply or a `send` typed into the pane right before a crash, which is typed again (`rules.md`).
