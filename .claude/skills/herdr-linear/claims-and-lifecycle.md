# Claims and lifecycle

How the dispatcher tracks each epic it touches (claims), the rules it applies every tick, how flagged, retried and restarted runs behave, and how tabs and worktrees are cleaned up.

## Claim statuses (`src/claims.ts`)

Flagged states use Linear's agent-session names.

| Status | Meaning | Counts toward `maxInFlight` |
| --- | --- | --- |
| `claimed` | Saved before `dispatch` is sent; worker has not confirmed yet. | yes |
| `running` | Worker sent `started`. | yes |
| `awaitingInput` | Agent sat `idle`, `done` or `blocked` without a PR for `awaitingInputAfterSeconds`; epic flagged. | yes |
| `stale` | herdr says `working` but the pane stopped changing; epic flagged. Detection not built yet. | yes |
| `error` | Agent `exited` or `vanished`, or the run never started (worker `failed`, start timeout, repo label unresolvable); epic flagged. | no |
| `ended` | Run over (PR up, or the epic moved on) and its tab closed. Kept only to clean the worktree up later. | no |
| `kept` | Cleanup found work not on origin; worktree kept and the epic told once. | no |

The rule: a claim holds a slot while its Claude process may be alive, so live agents never exceed `maxInFlight` (`IN_FLIGHT_STATUSES`, `dispatcher.ts:22`). `error`, `ended` and `kept` are never re-dispatched by themselves; an `ended` or `kept` claim is replaced by a fresh one if its epic is put back in Ready (without `agent-stuck`).

Older `claims.json` files load unchanged: `stuck` is read as `awaitingInput` and `failed` as `error` (zod preprocess in `claimStatusSchema`).

## `claims.json`

- Path: `$HERDR_PLUGIN_STATE_DIR/claims.json`, live: `~/.local/state/herdr/plugins/herdr-linear/claims.json`.
- Shape: `{ "claims": [ { epicId, identifier, teamId, status, claimedAt, job?, run?, agent? } ] }`.
- `agent` is `{ status, since, tail }`; status is an `AgentStatus` or `exited` / `vanished`.
- Written atomically (temp + fsync + rename, mode 600) on every `put` / `delete`. Missing file means no claims. Invalid file fails startup (zod).
- A released claim is deleted. There is no history; the log has it.

## One tick (`dispatcher.ts:49-75`)

1. Resolve teams and state IDs (see `linear-api.md`).
2. One `poll` query: ready epics plus every claimed epic wherever it is now.
3. Reconcile each claim, in order (rules below).
4. Read the pause file; log on change.
5. If not paused, dispatch ready epics: resolved team, no claim (or an `ended` / `kept` one), no `agent-stuck` label, has sub-issues, by `sortOrder`, until `maxInFlight`.

An exception anywhere aborts the rest of that tick and is logged as `poll failed: ...` (`dispatcher.ts:159-165`).

## Reconcile rules (`reconcile`, `dispatcher.ts:258`)

First match wins. "Working" means the last agent status is `working` or not reported yet.

| # | Condition | Action |
| --- | --- | --- |
| 1 | Epic not returned by Linear | Release ("no longer exists"). |
| 2 | Team skipped | Nothing. |
| 3 | `claimed` | `error` + flag once the start timeout passes. Otherwise nothing. |
| 4 | Run never started (no `job` or `run`) | Release if the epic left Ready or the label was removed. Otherwise nothing. |
| 5 | `ended` or `kept` | Send `cleanup` if the epic is in Shipped or its PR is merged or closed. |
| 6 | `running` and epic still in Ready | Move to Implementing (repairs a failed move). |
| 7 | Epic not in Implementing or In Review | End the run unless working. |
| 8 | Open or merged PR for `run.branch` | Unless working: move to To Review, remove `agent-stuck`, end the run. |
| 9 | Agent `exited` or `vanished` (not already `error`) | Comment + label, status `error`. |
| 10 | `running` and quiet for `awaitingInputAfterSeconds` | Comment + label, status `awaitingInput`. |

"End the run" = status `ended`, then send `close` (worker closes the tab). A working agent is never ended, since closing its tab would kill it mid-turn; the claim keeps its slot until it stops.

Rule 8 applies to flagged claims too, so a PR opened after flagging still hands the epic over.

## Flagging

- `idle`, `done`, `blocked`: quiet; `awaitingInput` once quiet for `awaitingInputAfterSeconds` (default 180).
- `exited`, `vanished`: `error` immediately, from `running`, `awaitingInput` or `stale`.
- `unknown` and `working` never count.
- Start timeout: a `claimed` claim not confirmed within `startTimeoutSeconds` (default 300) becomes `error` and frees its slot. After a dispatcher restart the window restarts, so the worker can adopt the run first. A late `started` still turns it into `running`; a late `failed` is only logged.

`agent.since` resets on every `status` message unless both the old and new status are quiet, so `idle` to `done` keeps the timer. An `awaitingInput` claim that reports `working` goes back to `running`, but the label stays until the PR rule removes it.

Flag = comment, then add label `agent-stuck`. Comments (`runComment`, `failureComment`) name the state, e.g. `**herdr-linear** (\`error\`): ...`, and include the pane tail in a code block. The epic stays where it was (Ready for runs that never started, Implementing or In Review otherwise).

## Retrying

| Situation | What the human does |
| --- | --- |
| `error`, never started | Fix the cause, remove `agent-stuck`. Released and re-dispatched the same tick. |
| `awaitingInput` | Answer it in its herdr tab. |
| `awaitingInput` or `error`, start over | Move the epic back to Ready (ends the run, closing its tab) and remove the label (allows dispatch). |

A re-dispatch reuses the existing worktree if it is on the same branch (see `worker-and-herdr.md`) and opens a new tab.

## Cleanup

- When a run ends: `close` closes its tab (only if the tab still has the run's label; a missing tab is fine).
- `ended` and `kept` claims stay in `claims.json`, so cleanup survives restarts. Each tick they are checked (rule 5): Shipped, or `findPullRequest` returns `MERGED` or `CLOSED`, sends `cleanup`.
- Worker `cleanup`: closes the tab, then removes the worktree and deletes the local branch, unless they hold uncommitted changes or commits on no origin branch. Then it replies `cleaned` (claim released) or `kept` (status `kept`, one comment with the path and reason).
- `cleanup` is re-sent every tick for `kept` claims, so pushing or discarding the work lets the next tick remove it. A worktree or branch already gone counts as cleaned.
- An `ended` claim whose epic stops existing in Linear is released without cleanup.

## Restart re-attach (`dispatcher.ts:39-47`, `worker.ts`)

On start the dispatcher sends `watch` for every in-flight claim (`claimed`, `running`, `awaitingInput`, `stale`) with a job:

- With `run`: worker tracks the pane again. If herdr restarted, the pane is gone and the worker reports `vanished`.
- Without `run` (claimed): worker "adopts": finds the tab by `tabLabel` in the `agents` workspace, checks Claude runs there, replies `started`. Otherwise `failed` ("the dispatch was interrupted before the agent was confirmed running").
