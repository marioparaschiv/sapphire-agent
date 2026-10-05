# Overview

What sapphire-agent does end to end, the Linear column flow, and who moves an issue between columns.

## In one paragraph

A systemd user service (`node src/main.ts`) runs one reconciler. Every `pollSeconds`, and right away when herdr reports an agent change or `scripts/ctl.sh` records a request, it observes Linear, herdr, git and GitHub and acts on the difference. Top-level issues ("epics") in "Ready For Agent" are claimed in the local journal; then a git worktree is created on the epic's Linear branch, a herdr tab is opened in the `agents` workspace and Claude Code is started there with a one-line `/orchestrate` prompt. The reconciler then watches the agent and the GitHub PR, and updates Linear. On GitHub, the user talks to the reconciler by mentioning the bot in plain language; the GitHub App's webhook delivers the comment to the service, and a command agent works out what they want and does it through `scripts/ctl.sh`.

## End-to-end steps

1. Human moves an epic to **Ready For Agent**.
2. The dispatch rule claims it (a journal row with status `claimed`).
3. The start rule prepares the worktree, trusts it for Claude, opens a tab, starts Claude and moves the epic to **Implementing** (status `running`).
4. The agent works through the sub-issues, moves the epic to **In Review** when it starts `/sreview`, runs `/pr`, reviews its own diff, then writes its result file.
5. Once the agent stops, the results rule reads the result file, posts the summary as a PR comment and the self-review flags as one review (both by the GitHub App), removes `agent-stuck` if present, moves the epic to **To Review**, closes the tab and ends the run (status `ended`).
6. Human reviews the PR (on GitHub or in Linear's review UI) and mentions the bot (`@<bot.login>`, e.g. `@orchestratorbot`) in a comment, a review or a review thread, in plain language: "fix the naming in these threads", "use the existing helper instead".
7. GitHub delivers the comment to the service's webhook server, which records it as a command and wakes the reconciler; the commands rule starts the command agent in a herdr tab. It reads the PR and the threads, replies as the GitHub App, and asks for a follow-up (`ctl.sh follow-up <EPIC> <instruction> --threads <id>...`), then says it is done and its tab closes.
8. The follow-up rule claims one follow-up run for the request; the start rule pulls the branch, opens a tab and starts `/follow-up` with the threads and the instruction. The epic goes to **Implementing**.
9. The follow-up agent changes, commits and pushes, self-reviews, and writes a result file with one reply per thread. The results rule posts the new summary and any flags, posts each reply into its thread and resolves it, moves the epic back to **To Review** and closes the tab.
10. When the PR is merged or closed (or the epic reaches Shipped), the cleanup rule removes the worktree and local branch and drops the run from the journal.

A mention can ask for anything the CLI does, not only follow-ups: "pause everything", "stop HL-12", "start HL-14", "tell the HL-9 agent to use the existing helper", "what is running?". See `rules.md` (Commands).

If the agent stops without a result file, hangs, or asks a question, see `rules.md`.

## Columns and who moves what

Epic columns:

| Column | Config key | Moved in by |
| --- | --- | --- |
| To Do | none | Human. The plugin never reads or sets it. |
| Ready For Agent | `states.ready` | Human. Also where an epic whose run never started stays until retried. |
| Implementing | `states.implementing` | Plugin, once Claude is confirmed started (initial or follow-up run). |
| In Review | `states.inReview` | Agent, when it starts `/sreview` (the orchestrate skill's rule). |
| To Review | `states.toReview` | Plugin, once the result is posted to the open or merged PR. A follow-up request is claimed only here. |
| Shipped | `states.shipped` | Not this code. Linear's GitHub integration on merge. |

Linear's GitHub automation (team settings) must be: PR opened to To Review, merged to Shipped, branch or start to no action. A "start" rule moving to In Progress would pull the epic back out of To Review.

Sub-issue columns (moved by the agent, per `~/.claude/skills/orchestrate/SKILL.md`):

- **Implementing** when it starts a sub-issue.
- **Done** when that slice is verified. The plugin does not check this state exists; the agent fails to move sub-issues if it doesn't.

## Things worth knowing up front

- Every role in `states` must exist in a team's workflow, including `shipped`, which the plugin never sets. A team missing one is skipped and logged once.
- Epics without sub-issues are ignored with a one-time log line.
- Only issues with no parent count as epics.
- Order is Linear board order (`sortOrder` ascending); at most `maxInFlight` runs at once, follow-ups first.
- The agent opens and pushes the PR as the user's account. Every comment sapphire-agent writes on GitHub (summaries, flags, thread replies and resolves, the command agent's replies, notices that a command failed) is the GitHub App's (`<slug>[bot]`). The bot (`@<bot.login>`) is mentioned to ask for something.
- Linear and GitHub are the source of truth. The journal only holds what cannot be observed (see `journal-and-markers.md`), and every comment carries a hidden marker so it is never posted twice.

## The prompts the agent gets

Built by the `Prompts` service, each on one line (herdr refuses newlines):

`/orchestrate Linear epic <ID> autonomously`, with `inline` before `autonomously` when the epic has no sub-issues.

`/follow-up Linear epic <ID>, PR <pr url>, threads <id1> <id2> ... (or: no threads), instruction "<text>" (when one was given)`

A command agent gets one line naming it (`CMD-<n>`), the author, the comment's URL and its text quoted as JSON, the `ctl.sh` subcommands, what it may read, and that it replies, then runs `done CMD-<n>` (`Prompts.command`).

The workflow lives in the skills, not in this code:

- Orchestrate (`~/.claude/skills/orchestrate/SKILL.md`, sections **Linear epics** and **Autonomous runs**): move sub-issues to Implementing and Done and the epic to In Review at `/sreview`. `autonomously` means: commit each verified slice, run `/pr` after `/sreview`, self-review and push fixes, write the result file, never post to GitHub; comment a question on the epic and stop if blocked.
- Follow-up (`~/.claude/skills/follow-up/SKILL.md`): reads the sub-issues, earlier PR summaries and the threads, makes and pushes the changes (and what the instruction asks), self-reviews as orchestrate does, and writes the result file with exactly one reply per thread id (none without threads). It never posts to GitHub and never moves the epic.

Changing the column names means editing those skills as well as `states` in the config.
