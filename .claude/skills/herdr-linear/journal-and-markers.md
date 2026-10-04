# Journal and markers

What herdr-linear stores locally and why, and how markers on its comments make every write safe to repeat.

## Reality first

Linear, herdr, git and GitHub are the source of truth. Every tick observes them again, so state that can be observed is never stored: the epic's state and labels, the tab and its agent, the worktree, the PR, its threads and comments. The journal holds only what cannot be observed: timers, the last pane output hash, the parsed result file, and the ids that tie a run to its tab and question.

Idempotency comes from markers on external writes, not from the journal: before a write, look for its marker (or its effect) and skip it when present.

## The journal

SQLite through `@effect/sql-sqlite-node` (the built-in `node:sqlite`), with its migrator. Rows are typed with Effect `Schema`; there is no ORM. The file is `$HERDR_PLUGIN_STATE_DIR/journal.db` (live: `~/.local/state/herdr/plugins/herdr-linear/journal.db`). Tests use `':memory:'` or a temp file. Columns are snake_case in SQLite and camelCase in code. Times are epoch milliseconds.

### `runs`

One row per epic (`epic_id` is the primary key); a new claim replaces the old row.

| Column | What and why |
| --- | --- |
| `epic_id`, `identifier`, `team_id` | Which epic, for lookups, log annotations and flags. |
| `status` | `claimed`, `running`, `awaitingInput`, `stale`, `error`, `ended`, `kept` (see `rules.md`). |
| `job` | JSON: `{ "_tag": "orchestrate" }` or `{ "_tag": "follow-up", "threadIds": [...] }`. The thread ids a follow-up answers; the threads stay unresolved on GitHub until it is posted. |
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

### Journal service

`getRun`, `listRuns` (ordered by claim time), `putRun` (insert or replace), `deleteRun`, `recordTransient` (returns the streak start), `clearTransient`. Rules read the journal when they plan, so each sees what the rules before it wrote this tick.

`node src/status.ts` (via `scripts/ctl.sh status`) prints the runs: identifier, status, job, claim time, tab and worktree.

## Markers

Every comment herdr-linear writes, on Linear or on the PR, ends with a hidden marker on a line of its own:

```
<!-- herdr-linear:<IDENTIFIER>:<purpose>:<key> -->
```

The key is URI-encoded. A marker inside a quote (`> <!-- ... -->`) does not count, so a user quoting one of our comments is not mistaken for it. Purpose and key together name one comment: a retry or restart finds it and skips, while a later occurrence (a new question in the same run, a new summary from a follow-up run) has a new key and is posted. The `Comments` service builds every body and key; `claimedAt` is the run's claim time.

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

On the GitHub PR:

| Purpose | Key | Posted |
| --- | --- | --- |
| `summary` | `<claimedAt>` | Once per run, as a PR comment. |
| `flags` | `<claimedAt>` | Once per run, as the COMMENT review holding every flag. |
| `reply` | `<threadId>.<claimedAt>` | Once per thread per run, among the thread's comments. |

Writes without a marker are idempotent by their effect: a move is skipped when the epic is already in that state, a label is added only if missing, a reaction only if the comment lacks that emoji, a thread is resolved only if unresolved, a tab close of a missing tab is a no-op, and worktree removal skips what is already gone.

## Crash safety

Every multi-step action is ordered so that a crash at any step leaves something the next tick finishes, without posting twice or skipping a step:

- Claim before start; record the worktree, then the tab, then `running`. An unrecorded tab is adopted, Claude found in the pane is not started again.
- Store the result before posting it; post each part only when its marker is missing; remove the label, move the epic, close the tab, and only then mark the run `ended`.
- Flags put the label on first, then the comment, then the journal update.
- Cleanup closes the tab, removes the worktree and branch, and only then drops the row.

`src/lifecycle.test.ts` proves it: it runs one epic through dispatch, a relayed question, results, a follow-up and cleanup, and repeats that with a crash injected at every journal, Linear, GitHub and herdr write, asserting the same end state and no double posts (`development.md`). The one known exception is a reply typed into the pane right before a crash, which is typed again (`rules.md`).
