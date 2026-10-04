# Claims and lifecycle

How the dispatcher tracks each epic it touches (claims), the rules it applies every tick, and how stuck, failed, retried and restarted runs behave.

## Claim statuses (`src/claims.ts:6-8`)

| Status | Meaning | Counts toward `maxInFlight` |
| --- | --- | --- |
| `claimed` | Saved before `dispatch` is sent; worker has not confirmed yet. | yes |
| `running` | Worker sent `started`. | yes |
| `stuck` | Agent stopped without a PR; epic was commented and labelled. | yes |
| `failed` | Run never started (worker `failed`, or repo label unresolvable). | no |

A stuck claim keeps its slot, so with `maxInFlight: 1` nothing new starts until it is resolved (`dispatcher.ts:21, 290`).

## `claims.json`

- Path: `$HERDR_PLUGIN_STATE_DIR/claims.json`, live: `~/.local/state/herdr/plugins/herdr-linear/claims.json`.
- Shape: `{ "claims": [ { epicId, identifier, teamId, status, claimedAt, job?, run?, agent? } ] }`.
- `agent` is `{ status, since, tail }`; status is an `AgentStatus` or `exited` / `vanished`.
- Written atomically (temp + fsync + rename, mode 600) on every `put` / `delete`. Missing file means no claims. Invalid file fails startup (zod).
- A released claim is deleted. There is no history; the log has it.

## One tick (`dispatcher.ts:45-71`)

1. Resolve teams and state IDs (see `linear-api.md`).
2. One `poll` query: ready epics plus every claimed epic wherever it is now.
3. Reconcile each claim, in order (rules below).
4. Read the pause file; log on change.
5. If not paused, dispatch ready epics: resolved team, unclaimed, no `agent-stuck` label, has sub-issues, by `sortOrder`, until `maxInFlight`.

An exception anywhere aborts the rest of that tick and is logged as `poll failed: ...` (`dispatcher.ts:131-137`).

## Reconcile rules (`dispatcher.ts:217-276`)

First match wins:

| # | Condition | Action |
| --- | --- | --- |
| 1 | Epic not returned by Linear | Release ("no longer exists"). |
| 2 | Team skipped, or status `claimed` | Nothing. |
| 3 | `failed` and epic left Ready, or label removed | Release. Otherwise nothing. |
| 4 | `running` and epic still in Ready | Move to Implementing (repairs a failed move). |
| 5 | Epic not in Implementing or In Review | Release (moved by a human or integration). |
| 6 | Live PR for `run.branch` | Move to To Review, remove `agent-stuck`, release. |
| 7 | `running` and agent stopped | Comment + label, status `stuck`. |

Rule 6 applies to `stuck` claims too, so a PR opened after flagging still hands the epic over.

## Stuck detection

"Stopped" (`dispatcher.ts:278-286`):

- `exited` or `vanished`: immediately.
- `idle`, `done`, `blocked`: once quiet for `stuckAfterSeconds` (default 180).
- `unknown` and `working` never count.

`agent.since` resets on every `status` message unless both the old and new status are quiet, so `idle` to `done` keeps the timer (`dispatcher.ts:97-100`). A `stuck` claim that reports `working` goes back to `running`, but the label stays until the PR rule removes it.

## Failure path

- Worker `failed` message or bad repo label: claim `failed`, then `flag` = comment, then add label `agent-stuck` (`dispatcher.ts:210-215`).
- Comment templates: `stuckComment` and `failureComment` (`dispatcher.ts:377-399`), including the pane tail in a code block.
- The epic stays where it was (Ready for failures, Implementing or In Review for stuck).

## Retrying

| Situation | What the human does |
| --- | --- |
| `failed` | Fix the cause, remove `agent-stuck`. Released and re-dispatched the same tick. |
| `stuck`, agent can continue | Answer it in its herdr tab. |
| `stuck`, start over | Move the epic back to Ready (releases the claim) and remove the label (allows dispatch). |

A re-dispatch reuses the existing worktree if it is on the same branch (see `worker-and-herdr.md`) and opens a new tab.

## Restart re-attach (`dispatcher.ts:37-43`, `worker.ts:58-150`)

On start the dispatcher sends `watch` for every `claimed`, `running` or `stuck` claim with a job:

- With `run` (running, stuck): worker tracks the pane again. If herdr restarted, the pane is gone and the worker reports `vanished`.
- Without `run` (claimed): worker "adopts": finds the tab by `tabLabel` in the `agents` workspace, checks Claude runs there, replies `started`. Otherwise `failed` ("the dispatch was interrupted before the agent was confirmed running").

A `claimed` claim has no timeout; it only resolves via `started`, `failed`, or the epic disappearing.
