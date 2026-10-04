# Overview

What herdr-linear does end to end, the Linear column flow, and who moves an issue between columns.

## In one paragraph

A dispatcher (systemd user service, `node src/main.ts`) polls Linear every `pollSeconds`. Top-level issues ("epics") in "Ready For Agent" that have sub-issues get claimed on disk, then a worker creates a git worktree on the epic's Linear branch, opens a herdr tab in the `agents` workspace and starts Claude Code with a one-line `/orchestrate` prompt. The dispatcher then watches the run and the GitHub PR, and updates Linear.

## End-to-end steps

1. Human moves an epic to **Ready For Agent**.
2. Dispatcher claims it (`claims.json`, status `claimed`) and sends `dispatch` to the worker.
3. Worker prepares the worktree, trusts it for Claude, opens a tab, starts Claude, replies `started`.
4. Dispatcher moves the epic to **Implementing** (`dispatcher.ts:94-96`).
5. Agent works through sub-issues, moves the epic to **In Review** when it starts `/sreview`, then runs `/pr`.
6. Dispatcher sees an open or merged PR via `gh` and, once the agent stops working, moves the epic to **To Review**, removes `agent-stuck` if present, marks the claim `ended` and has the worker close the tab.

If the agent stops without a PR, see `claims-and-lifecycle.md`.

## Columns and who moves what

Epic columns:

| Column | Config key | Moved in by |
| --- | --- | --- |
| To Do | none | Human. The plugin never reads or sets it. |
| Ready For Agent | `states.ready` | Human. Also where an epic whose run never started stays until retried. |
| Implementing | `states.implementing` | Plugin, after the worker confirms Claude started. |
| In Review | `states.inReview` | Agent, when it starts `/sreview` (the orchestrate skill's rule). |
| To Review | `states.toReview` | Plugin, when a PR for the branch is open or merged. |
| Shipped | `states.shipped` | Not this code. Linear's GitHub integration on merge. |

Linear's GitHub automation (team settings) must be: PR opened → To Review, merged → Shipped, branch/start → no action. A "start" rule moving to In Progress would pull the epic back out of To Review.

Sub-issue columns (moved by the agent, per `~/.claude/skills/orchestrate/SKILL.md`):

- **Implementing** when it starts a sub-issue.
- **Done** when that slice is verified. The plugin does not check this state exists; the agent fails to move sub-issues if it doesn't.

## Things worth knowing up front

- Every role in `states` must exist in a team's workflow, including `shipped`, which the plugin never sets. A team missing one is skipped (`resolveTeams`).
- Epics without sub-issues are ignored with a one-time log line (`dispatchReady`).
- Only issues with no parent count as epics (`linear.ts:99`).
- Order is Linear board order (`sortOrder` ascending); at most `maxInFlight` runs at once.
- The dispatcher is the only component that talks to Linear; the worker only touches git, herdr and `~/.claude.json`.

## The prompt the agent gets

Built in `buildJob` (`src/dispatcher.ts`), one line:

`/orchestrate the sub-issues of Linear epic <ID> (<url>) autonomously, in the worktree you are in.`

The workflow lives in the orchestrate skill (`~/.claude/skills/orchestrate/SKILL.md`), sections **Linear epics** and **Autonomous runs**:

- Move sub-issues to Implementing / Done and the epic to In Review at `/sreview`.
- `autonomously` means: commit each verified slice, run `/pr` after `/sreview`, comment a question on the epic and stop if blocked.

Changing the column names means editing that skill as well as `states` in the config.
