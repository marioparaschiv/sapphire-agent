# Claims and lifecycle

How the dispatcher tracks each epic it touches (claims), the rules it applies every tick, how flagged, retried and restarted runs behave, and how tabs and worktrees are cleaned up.

## Claim statuses (`src/claims.ts`)

Flagged states use Linear's agent-session names.

| Status | Meaning | Counts toward `maxInFlight` |
| --- | --- | --- |
| `claimed` | Saved before `dispatch` is sent; worker has not confirmed yet. | yes |
| `running` | Worker sent `started`. | yes |
| `awaitingInput` | Agent sat `idle`, `done` or `blocked` without a result file for `awaitingInputAfterSeconds`; epic flagged with the question (see Elicitation). | yes |
| `stale` | herdr says `working`, the pane tail did not change for `staleAfterSeconds`, a nudge did not help within `nudgeGraceSeconds`; epic flagged. | yes |
| `error` | Agent `exited` or `vanished` without a result file, invalid result file, result file whose `replies` do not match the dispatched threads, result file but no open or merged PR, or an initial run never started (worker `failed`, start timeout, repo label unresolvable); epic flagged. | no |
| `ended` | Run over (result posted to the PR, or the epic moved on) and its tab closed, or a follow-up that never started (flagged). Kept to clean the worktree up later and to scan its PR for `/agent` threads. | no |
| `kept` | Cleanup found work not on origin; worktree kept and the epic told once. | no |

The rule: a claim holds a slot while its Claude process may be alive, so live agents never exceed `maxInFlight` (`IN_FLIGHT_STATUSES`). `error` and `kept` are never re-dispatched by themselves. An `ended` or `kept` claim is replaced by a fresh one if its epic is put back in Ready (without `agent-stuck`); an `ended` one also by a follow-up when its PR has pending threads (see Follow-up runs).

Older `claims.json` files load unchanged: `stuck` is read as `awaitingInput` and `failed` as `error` (zod preprocess in `claimStatusSchema`).

## `claims.json`

- Path: `$HERDR_PLUGIN_STATE_DIR/claims.json`, live: `~/.local/state/herdr/plugins/herdr-linear/claims.json`.
- Shape: `{ "claims": [ { epicId, identifier, teamId, status, claimedAt, job?, run?, agent?, nudgedAt?, overCap?, questionCommentId?, result? } ] }`. A follow-up's `job.threadIds` holds the thread ids it was dispatched for.
- `agent` is `{ status, since, tail }`; status is an `AgentStatus` or `exited` / `vanished`. `since` is when the status (or, while `working`, the tail) last changed.
- `nudgedAt`: the current stale episode's nudge. `overCap`: the cap flag was posted. `questionCommentId`: the current awaitingInput question comment. `result`: `{ file, posted, replied, resolved }`, the result file, which of `summary` / `review` are on the PR already, and the thread ids already replied to and resolved (`replied` / `resolved` default to `[]` for older files).
- Written atomically (temp + fsync + rename, mode 600) on every `put` / `delete`. Missing file means no claims. Invalid file fails startup (zod).
- A released claim is deleted. There is no history; the log has it.

## One tick (`tick`)

1. Resolve teams and state IDs (see `linear-api.md`).
2. One `poll` query: ready epics, every claimed epic wherever it is now, and the replies to awaitingInput question comments.
3. Reconcile each claim, in order (rules below).
4. Deliver new replies (see Elicitation).
5. Read the pause file; log on change.
6. If not paused, dispatch follow-ups (below), then ready epics: resolved team, no claim (or an `ended` / `kept` one), no `agent-stuck` label, has sub-issues, by `sortOrder`. Both stop at `maxInFlight`; follow-ups go first.

An exception anywhere aborts the rest of that tick and is logged as `poll failed: ...` (`serial`). The next tick retries.

## Reconcile rules (`reconcile`)

First match wins. "Working" means the last agent status is `working` or not reported yet.

| # | Condition | Action |
| --- | --- | --- |
| 1 | Epic not returned by Linear | Release ("no longer exists"). |
| 2 | Team skipped | Nothing. |
| 3 | `claimed` | `error` + flag once the start timeout passes. Otherwise nothing. |
| 4 | Run never started (no `job` or `run`) | Release if the epic left Ready or the label was removed. Otherwise nothing. |
| 5 | `ended` or `kept` | Send `cleanup` if the epic is in Shipped or its PR is merged or closed. |
| 6 | Not `error`, not yet `overCap`, `maxRunSeconds` since `claimedAt` | Comment + label once (`overCap`). Status unchanged. |
| 7 | `running` and epic still in Ready | Move to Implementing (repairs a failed move). |
| 8 | Epic not in Implementing or In Review | End the run unless working. |
| 9 | Claim has a `result` | Unless working: post it (below), move to To Review, remove `agent-stuck`, end the run. |
| 10 | Agent `exited` or `vanished` (not already `error`) | Comment + label, status `error`. |
| 11 | `running` and quiet for `awaitingInputAfterSeconds` | Question comment + label, status `awaitingInput`. |
| 12 | `running` and `working` | Stale check (below). |

"End the run" = status `ended`, then send `close` (worker closes the tab). A working agent is never ended, since closing its tab would kill it mid-turn; the claim keeps its slot until it stops. A `stale` agent counts as stopped: it only claims to be working.

An open PR alone no longer ends a run: the result file is the completion signal. Rule 9 applies to flagged claims too.

## Result file

- The agent writes `"$(git rev-parse --git-dir)/herdr-result.json"` as its last step (orchestrate skill). It lives in the worktree's git dir, so it is never committed. The worker deletes a leftover one when it starts a run in a reused worktree.
- The worker reads it (`readResultFile`, `git.ts`) whenever the agent is not `working`, and before reporting `exited` / `vanished`, so it is never read half-written. It sends `result` or `invalidResult` once per tracked run.
- `result`: saved on the claim. `invalidResult`: `error` + comment with the zod message.
- Posting (rule 9, `finishRun`): first `replies` must hold exactly one entry per id in `job.threadIds` (none for an initial run). Otherwise `error`, a comment naming the missing, unknown and repeated ids, and nothing is posted. Then it needs an open or merged PR for the branch, else `error`. Then the summary as a PR comment, all `flags` as one `COMMENT` review with inline comments (none when `flags` is empty), and for each reply: post it into its thread, then resolve the thread. Each step is saved (`posted`, `replied`, `resolved`) right after it succeeds, so a restart or a failed `gh` call carries on without posting anything twice. A `gh` failure aborts the tick and is retried next tick.
- Instead of re-requesting the user's review, the summary mentions the PR author (the user's own account; GitHub rejects review requests from the author, and Linear's public API has no review-request mutation).

## Follow-up runs

Pending rule (`isPending`, `github.ts`): a review thread is pending when it is unresolved and its latest comment without the onBehalfOf block contains `/agent`, in its body or in the body of the review it was submitted with. So `/agent` in a review body tags every thread of that review, the agent's own flags and replies never count, a flag the user answered `/agent` counts, and a resolved flag is dismissed.

- Scan (`dispatchFollowUps`, every tick while not paused): every `ended` claim whose epic is in To Review without `agent-stuck`. One `gh api graphql` query per claim reads the branch's open PR and its review threads (up to 100; more aborts the tick). Nothing is stored: pending is read from GitHub each time.
- Dispatch: all pending threads of the PR in one run. A fresh `claimed` claim with `job.threadIds` and the previous `run` (same worktree; needed for cleanup), then `dispatch`. The epic moves to Implementing on `started`, as for initial runs, and back to To Review when the result is posted.
- Restart safety: an in-flight claim is never scanned, so a restart mid-run dispatches nothing again; `start` sends `watch` without the old `run` for a `claimed` claim, so the worker adopts the new tab. The ids are on disk in `job.threadIds`, and the threads stay unresolved on GitHub until the dispatcher replies, so a lost run finds them again.
- Never started (worker `failed` or start timeout): back to `ended` + flag. The label stops the scan; removing it dispatches the follow-up again.
- Reply mismatch: `error` + flag, nothing posted, tab left open. Remove the label and move the epic to To Review: rule 8 ends the run and the still-pending threads start a new follow-up.

## Flagging

- `idle`, `done`, `blocked`: quiet; `awaitingInput` once quiet for `awaitingInputAfterSeconds` (default 180), PR or not, as long as there is no result file.
- `exited`, `vanished`: `error` immediately, from `running`, `awaitingInput` or `stale`.
- `unknown` and `working` never count.
- Start timeout: a `claimed` claim not confirmed within `startTimeoutSeconds` (default 300) becomes `error` and frees its slot. After a dispatcher restart the window restarts, so the worker can adopt the run first. A late `started` still turns it into `running`; a late `failed` is only logged.

`agent.since` resets on every `status` message unless both the old and new status are quiet (so `idle` to `done` keeps the timer) or status and tail are both unchanged. An `awaitingInput` claim that reports `working` goes back to `running`, but the label stays until the run finishes.

Stale (`checkStale`, timing in the dispatcher with the injected clock):

- `running`, `working`, tail unchanged for `staleAfterSeconds`: send `nudge` once and save `nudgedAt`.
- Any tail or status change clears `nudgedAt`; a `stale` claim goes back to `running`.
- Still unchanged `nudgeGraceSeconds` after the nudge: comment with the tail + label, status `stale`. It keeps its slot.
- `nudgedAt` is on disk, so a restart does not nudge again.
- Tails are compared without digits or spinner glyphs (`withoutTickers` in `dispatcher.ts`): the spinner, its timer and the status line counters keep ticking while a turn hangs.

Wall-clock cap: rule 6, once per claim (`overCap` on disk), in any in-flight state. The run keeps going and keeps its slot.

Flag = comment, then add label `agent-stuck`. Comments (`runComment`, `failureComment`, `overCapComment`, `invalidResultComment`) start with `**herdr-linear`, name the state, e.g. `**herdr-linear** (\`error\`): ...`, and include the pane tail or error in a code block. The epic stays where it was (Ready for runs that never started, Implementing or In Review otherwise).

## Elicitation

- The `awaitingInput` comment is the question: it holds the pane tail and says to reply to it. Its ID is saved as `questionCommentId`, so it is posted once per episode, also across restarts. The episode ends when the agent works again.
- Each tick, `poll` fetches the children of every current question comment in the same request.
- A reply counts when it is a child of the claim's current question, does not start with `**herdr-linear` (the dispatcher posts with the user's key, so the marker is the only tell), and has no `white_check_mark` reaction.
- Delivery: add the reaction first, then send `reply`. A reply is never typed twice, also across restarts. The worker runs `herdr agent prompt <pane> <text>` with newlines joined into spaces (herdr rejects newlines).
- herdr refuses a prompt while the agent sits at a permission or question dialog (`agent_blocked`). The worker then sends `replyFailed` and the dispatcher replies in the thread to answer in the tab.
- Replies to any other comment are ignored.

## Retrying

| Situation | What the human does |
| --- | --- |
| `error`, never started | Fix the cause, remove `agent-stuck`. Released and re-dispatched the same tick. |
| `awaitingInput` | Reply to the question comment on the epic, or answer in its herdr tab. |
| `stale` or over the cap | Look at the tab; the run carries on by itself once the pane changes. |
| `awaitingInput` or `error`, start over | Move the epic back to Ready (ends the run, closing its tab) and remove the label (allows dispatch). |

A re-dispatch reuses the existing worktree if it is on the same branch (see `worker-and-herdr.md`) and opens a new tab.

## Cleanup

- When a run ends: `close` closes its tab (only if the tab still has the run's label; a missing tab is fine).
- `ended` and `kept` claims stay in `claims.json`, so cleanup survives restarts. Each tick they are checked (rule 5): Shipped, or `findPullRequest` returns `MERGED` or `CLOSED`, sends `cleanup`.
- Worker `cleanup`: closes the tab, then removes the worktree and deletes the local branch, unless they hold uncommitted changes or commits on no origin branch. Then it replies `cleaned` (claim released) or `kept` (status `kept`, one comment with the path and reason).
- `cleanup` is re-sent every tick for `kept` claims, so pushing or discarding the work lets the next tick remove it. A worktree or branch already gone counts as cleaned.
- An `ended` claim whose epic stops existing in Linear is released without cleanup.

## Restart re-attach (`dispatcher.ts:44-53`, `worker.ts`)

On start the dispatcher sends `watch` for every in-flight claim (`claimed`, `running`, `awaitingInput`, `stale`) with a job, without `run` for `claimed` ones:

- With `run`: worker tracks the pane again. If herdr restarted, the pane is gone and the worker reports `vanished`.
- Without `run` (claimed): worker "adopts": finds the tab by `tabLabel` in the `agents` workspace, checks Claude runs there, replies `started`. Otherwise `failed` ("the dispatch was interrupted before the agent was confirmed running").
