# Rules

What each rule of the reconciler does, the run statuses they move between, flags, the question relay, when tabs close, which tabs and worktrees herdr-linear owns, how to retry, and the known limits. The rules run in the order below every tick (see `architecture.md`).

## Runs and statuses

A run is one journal row per epic: the current or last agent run for it. Statuses (`RunStatus`):

| Status | Meaning | Counts toward `maxInFlight` |
| --- | --- | --- |
| `claimed` | Recorded before anything is started; the start rule takes it from here. | yes |
| `running` | Claude was confirmed started in the pane. | yes |
| `awaitingInput` | The agent sat `idle`, `done` or `blocked` without a result file for `awaitingInputAfterSeconds`; the epic is flagged with the question. | yes |
| `stale` | herdr says `working` but the pane output did not change for `staleAfterSeconds`, and a nudge did not help within `nudgeGraceSeconds`; the epic is flagged. | yes |
| `error` | The agent exited or vanished without a result file, the result file was invalid or did not match its threads, there was no PR for it, or the run never started; the epic is flagged. | no |
| `ended` | The run is over and its tab closed (result posted, epic moved on, or a follow-up that never started). Kept to clean the worktree up later and to scan its PR for `/agent` threads. | no |
| `kept` | Cleanup found work that is not on origin, so the worktree stays; the epic was told once. | no |

A run holds a slot while its Claude process may be alive, so live agents never exceed `maxInFlight`. A run's job is `orchestrate` or `follow-up` (with the thread ids it answers).

Which Linear states a run belongs in (`activeRoles`): a started run in Implementing or In Review; a claim that never started in Ready (or Implementing, once the start moved it); a follow-up claim in To Review (or Implementing). An epic outside them ends the run.

"Working" below means herdr reports the run's agent as `working`, unless the run is `stale` (a stale agent only claims to be working). A working agent's tab is never closed, since that would kill it mid-turn; the rule waits for a later tick.

## 1. Cleanup

For each tracked run whose epic shipped, whose PR was merged or closed, or (for an initial run that never started) that ended:

1. Close its tab.
2. No worktree: drop the row.
3. Unsaved work (uncommitted changes, or commits on no origin branch): keep the worktree, comment `keptWorktree` on the epic once, status `kept`. Each tick checks again, so pushing or discarding the work lets a later tick remove it.
4. Otherwise remove the worktree and local branch, then drop the row.

A `claimed` run is never cleaned up. A run whose epic no longer exists in Linear is dropped. Cleanup also resolves orphans (below).

## 2. Results

For each run that is `claimed`, `running`, `awaitingInput`, `stale` or `error`, once the agent is not working:

- Epic outside the run's states: end the run (close the tab, `ended`).
- Stored result: finish the run (below). This also retries an `error` run whose result is stored, e.g. once the missing PR exists.
- Otherwise read the result file. Valid: store it on the run, then finish. Invalid: `invalidResult` flag, `error`.

The result file is `herdr-result.json` in the worktree's own git dir (`git rev-parse --git-dir`), so it is never committed. The agent writes it as its last step and it is only read once the agent stopped, so it is never half-written. Schema (`ResultFile`): `summary`, `replies[{ threadId, body }]`, `flags[{ path, line, body }]`. A valid file is the completion signal; an open PR alone does not end a run.

Finishing a run (`finishRun`):

1. `replies` must hold exactly one entry per thread id of a follow-up job (none for an initial run). Otherwise a `threadMismatch` flag naming the missing, unknown and repeated ids, `error`, and nothing is posted.
2. It needs an open or merged PR for the branch. Otherwise a `noPullRequest` flag and `error`.
3. Post the summary as a PR comment, ending with `Ready for review, @<PR author>.` (GitHub refuses review requests from the author, the user's own account, so a mention notifies them).
4. Post all flags as one COMMENT review with inline comments, if there are any.
5. For each reply: post it into its thread, then resolve the thread.
6. Remove `agent-stuck` if present, move the epic to To Review, close the tab, `ended`. The label goes first, so a crash right after the move leaves a run whose epic moved on, which the next tick only has to end.

Each PR write checks its marker first, so a retry or restart never posts twice (`journal-and-markers.md`).

## 3. Monitoring

For each started run that is `running`, `awaitingInput` or `stale`, every tick reads the agent status and the last 40 pane lines from herdr. The poll is authoritative, so a dropped socket event changes nothing.

- Tracking: `agentStatusSince` restarts on every change, except between quiet statuses (`idle` to `done` keeps the timer) and while status and output stay the same. Output is compared without digits and spinner glyphs, which keep ticking while a turn hangs. Any change clears the nudge; a change ends a `stale` episode and working again ends an `awaitingInput` one (back to `running`; the label stays until the run finishes).
- Wall-clock cap: `maxRunSeconds` after the claim, an `overCap` flag once. The run keeps going and keeps its slot.
- A run with a stored result, or whose epic moved on, is left to the results rule.
- Agent `exited` (pane without Claude) or `vanished` (tab gone): `error` flag with the tail, close the tab, `error`.
- `running` and quiet for `awaitingInputAfterSeconds`: `awaitingInput` flag with the tail; its comment id becomes the run's question.
- `running` and working with unchanged output for `staleAfterSeconds`: record `nudgedAt`, then nudge once (Esc, then the prompt `continue`). Still unchanged `nudgeGraceSeconds` later: `stale` flag, `stale`. It keeps its slot and its tab.
- `awaitingInput` with a question: relay replies (below).

`unknown` and `working` never count as quiet.

### Question relay

- The `awaitingInput` comment is the question: it holds the pane tail and says to reply to it. It is posted once per quiet episode, also across restarts (its marker is keyed by the claim and the start of the quiet spell).
- Each tick fetches the replies to every current question in one request. A reply counts when it is a child of the run's question, has no marker, does not start with `**herdr-linear`, and has no `white_check_mark` reaction. Replies to any other comment are ignored.
- Delivery, oldest first: type the reply into the pane (`herdr agent prompt`, lines joined with spaces), record its id on the run, then add the `white_check_mark` reaction. A recorded reply is never typed again and gets the reaction on the next tick if it is missing.
- herdr refuses a prompt while the agent sits at a permission or question dialog (`agent_blocked`). The reply then gets a `replyFailed` notice in the question's thread, once, saying to answer in the tab; that notice also keeps it from being typed later.

## 4. Follow-up

Skipped while paused. For each `ended` run whose epic is in To Review, in a resolved team, without `agent-stuck`, while `maxInFlight` allows: read the branch's open PR and its review threads. If any are pending, claim one follow-up run for all of them (`claimed`, job `follow-up` with the thread ids), replacing the ended row. The start rule then pulls the branch, opens a tab and starts `/follow-up`.

Pending rule (`isPending`): a thread is pending when it is unresolved and the user's latest comment in it (comments carrying the onBehalfOf block are the agent's own) contains `/agent`, in its body or in the body of the review it was submitted with. So `/agent` in a review body tags every thread of that review, the agent's own flags and replies never count, a flag the user answered with `/agent` counts, and a resolved flag is dismissed. Nothing is stored about threads: pending is read from GitHub every time, and a thread stays pending until the reply is posted and it is resolved.

Only an `ended` run is scanned: an in-flight one already holds the epic, so a restart mid-run claims nothing twice.

## 5. Dispatch

Skipped while paused. Claims ready epics in Linear board order (`sortOrder`) up to `maxInFlight`: a top-level epic in a resolved team's ready state, with sub-issues (otherwise logged once and ignored), without `agent-stuck`, with no run or only one that is over (`ended`, `kept`, or `error` without having started). The claim records the repo: the team's `repo`, or the repo named by a repo label (`linear-api.md`). An unresolvable repo label is a Permanent failure, which flags the epic.

## 6. Start

Not paused, so a claim made before a pause still starts. Takes each `claimed` run whose epic is in its states through these steps, one start at a time (they race on `~/.claude.json` and on creating the workspace). Each step looks at what is already there, so after a crash the next tick carries on where it stopped:

1. Worktree: prepare it (an existing one on the same branch is reused), pull the branch for a follow-up (`git pull --ff-only origin <branch>`), remove a leftover result file, record the path.
2. Trust the worktree for Claude.
3. Tab: adopt an owned tab of the epic that no run tracks and that herdr still has (e.g. one opened just before a crash), otherwise open a new one; record the tab and pane.
4. Claude: if Claude is not already in the pane, start it with the prompt for the job (the follow-up prompt needs the PR's URL). Then herdr must show Claude in the pane, not `blocked`.
5. Move the epic to Implementing (if not there yet), status `running`.

A step that fails Permanently, or a claim not confirmed within `startTimeoutSeconds` (counted from the claim, or from the process start if later, so a restart gets a full window), fails the start: a `startFailed` flag with the pane tail if there is one. An initial run becomes `error` and stays in Ready. A follow-up goes back to `ended` in To Review (moving the epic back if needed), keeping its worktree; removing the label lets the follow-up rule claim it again.

## Flags

A flag is the `agent-stuck` label plus a marked comment on the epic, once. The label goes on first: a crash between the two leaves no marker, so the next tick finishes the flag, while a marker found means the flag is complete and a label the user removed since stays removed.

| Flag | When | Status after |
| --- | --- | --- |
| `awaitingInput` | Quiet without a result file | `awaitingInput` |
| `stale` | Working, no new output even after a nudge | `stale` |
| `error` | Agent exited or vanished without a result file | `error` |
| `overCap` | Over `maxRunSeconds` | unchanged |
| `startFailed` | Start failed or timed out | `error`, or `ended` for a follow-up |
| `invalidResult` | Result file is not valid JSON or fails the schema | `error` |
| `noPullRequest` | Result file but no open or merged PR | `error` |
| `threadMismatch` | Replies do not match the follow-up's threads | `error` |
| `permanentFailure` | A call for the epic failed and retrying cannot help | unchanged |

Comments start with `**herdr-linear**`, name the state, e.g. ``**herdr-linear** (`error`): ...``, and include the pane tail or error in a code block plus what to do next. The epic stays where it was. A `transientFailure` comment (no label) and the comments `keptWorktree`, `replyFailed` and `workingOrphan` are notices, not flags. See `failure-policy.md` for the failure flags.

## Tab close

A run's tab is closed when any of these is true:

- the result file was read and every part is confirmed on the PR (all markers present);
- the epic left the run's states;
- the pane exited or the agent vanished (after the `error` flag is posted);
- the PR was merged or closed, or the epic shipped (cleanup).

The tab stays open while the run is `awaitingInput` or `stale`, and while the agent is working. A run's tab is found by its tab id and pane id together, so a tab the user renamed still closes, while a new tab that only reuses an old id is never closed. A tab already gone is fine.

## Ownership and orphans

herdr-linear owns the tabs in its own workspace (`workspaceLabel`, default `agents`) whose label starts with an issue identifier (`^[A-Z]+-\d+ `), for an epic of a resolved team. It never touches any other tab or workspace.

Owned tabs that no run tracks (cleanup rule):

- The epic is in Ready, Implementing or In Review and has no run: the first such tab is adopted as a claimed run, which the start rule confirms (starting Claude in it if Claude is not there).
- Otherwise, the agent is not working: the tab is closed.
- The agent is working: a `workingOrphan` comment once, and the tab is left running; it is closed once the agent stops.
- A claim whose tab was opened just before a crash is left to the start rule, which adopts it.

Orphan worktrees: a worktree under the worktrees directory that no run tracks, whose branch is the epic's Linear branch, whose path is the one herdr-linear would build, and whose epic is finished (a completed or canceled state) with no run. It goes through the unsaved-work check: removed with its branch, or kept with a `keptWorktree` comment naming the path (once per path).

## Retrying

| Situation | What the human does |
| --- | --- |
| `startFailed` on an initial run | Fix the cause, remove `agent-stuck`. The epic is still in Ready, so it is claimed again. |
| `startFailed` on a follow-up | Fix the cause (often: push the branch so `pull --ff-only` works), remove the label. The pending threads are claimed again. |
| `awaitingInput` | Reply to the question comment on the epic (typed into the pane), or answer in its herdr tab. |
| `stale` or over the cap | Look at the tab; the run carries on by itself once the pane changes. |
| `noPullRequest` | Open the PR; the next tick posts the stored result. Or start over. |
| `threadMismatch` on a follow-up | Remove the label and move the epic to To Review: the run ends and the still-pending threads start a new follow-up. |
| Start over (`awaitingInput`, `error`, `stale`, `invalidResult`) | Move the epic back to Ready (ends the run, closing its tab once the agent is not working) and remove the label (allows the claim). |

A new claim reuses the existing worktree if it is on the same branch and opens a new tab.

## Known limits

- The orphan-worktree sweep cannot tell herdr's own worktrees from herdr-linear's for a finished epic: both use the same directory layout and Linear's branch name. Only clean ones are removed; one with unsaved work gets a `keptWorktree` comment and stays.
- Orphan-tab adoption can start Claude while paused: adoption is part of cleanup and the start rule is not pausable.
- A crash after a reply was typed into the pane but before it was recorded types it again after the restart. Typing and recording cannot be one step, and typing twice beats losing the reply.
- A run whose agent keeps reporting `working` holds its slot and its tab until it stops or is flagged `stale`.
