# Overview

What sapphire-agent does end to end, the Linear column flow, and who moves an issue between columns.

## In one paragraph

A systemd user service (`node src/main.ts`) runs one reconciler. At startup, every `pollSeconds` (10 minutes by default, a backstop), and right away when Linear delivers a webhook, a run's T3 thread stops, an agent's hook reports an event or `scripts/ctl.sh` records a request, it observes Linear, T3, git and GitHub and acts on the difference. Top-level issues ("epics") in "Ready For Agent" are claimed in the local journal; then a full-access T3 Code thread is launched in a new worktree of the epic's Linear branch with a one-line `/orchestrate` prompt, and the service keeps a `t3_thread_wait` open on it so its end wakes the reconciler. The teams it watches are its projects, kept in the journal and managed with `sapphire project`. The reconciler then watches the agent and the GitHub PR, updates Linear, and tells the user how the run goes in notices, comments on the epic in Linear. What it has to say about itself (it cannot observe Linear, or cannot read its pause file) goes to the user's phone through Pushover. On GitHub, the user talks to the reconciler by mentioning the bot in plain language; the GitHub App's webhook delivers the comment to the service, and a command agent works out what they want and does it through `scripts/ctl.sh`.

## End-to-end steps

1. Human moves an epic to **Ready For Agent**, or runs `sapphire dispatch <ID>` (the `/dispatch` skill), which moves it there.
2. The dispatch rule claims it (a journal row with status `claimed`).
3. The start rule launches the epic's T3 thread and moves the epic to **Implementing** (status `running`).
4. The agent works through the sub-issues, moves the epic to **In Review** when it starts `/sreview`, runs `/pr`, reviews its own diff, then writes its result file.
5. Once the agent stops, the results rule reads the result file, comments `PR opened: <url>` on the epic once per PR, posts the summary and the unfixed self-review flags on the epic as notices, removes `agent-stuck` if present, moves the epic to **To Review** and ends the run (status `ended`).
6. Human reviews the PR (on GitHub or in Linear's review UI) and mentions the bot (`@<bot.login>`, e.g. `@orchestratorbot`) in a comment, a review or a review thread, in plain language: "fix the naming in these threads", "use the existing helper instead".
7. GitHub delivers the comment to the service's webhook server, which records it as a command and wakes the reconciler; the commands rule starts the command agent in a supervised, read-only T3 thread. It reads the PR and the threads, replies to the user as the bot on the PR (`ctl.sh reply`), and asks for a follow-up (`ctl.sh follow-up <EPIC> <instruction> --threads <id>...`), then says it is done and its thread is settled.
8. The follow-up rule claims one follow-up run for the request; the start rule pulls the branch and launches a T3 thread in the epic's worktree with `/follow-up`, the threads and the instruction. The epic goes to **Implementing**.
9. The follow-up agent changes, commits and pushes, self-reviews, and writes a result file with one reply per thread. The results rule posts each reply into its thread and resolves it, comments `Addressed your concerns inline.` on the PR once, posts the new summary and any flags on the epic, moves the epic back to **To Review** and ends the run.
10. When the PR is merged or closed (or the epic reaches Shipped), the cleanup rule settles the run's thread, removes the worktree and local branch and drops the run from the journal.

A mention can ask for anything the CLI does, not only follow-ups: "pause everything", "stop HL-12", "dispatch HL-14", "tell the HL-9 agent to use the existing helper", "what is running?". See `rules.md` (Commands).

If the agent stops without a result file, hangs, or asks a question, see `rules.md`. When a run's agent or one of its subagents fills `handoffAtTokens` of context, it hands its work to a fresh session (`rules.md`, Handoff).

## Columns and who moves what

Epic columns:

| Column | Config key | Moved in by |
| --- | --- | --- |
| To Do | none | Human. sapphire-agent never reads or sets it. |
| Ready For Agent | `states.ready` | Human, or `sapphire dispatch`. Also where an epic whose run never started stays until retried. |
| Implementing | `states.implementing` | sapphire-agent, once the run's T3 thread is launched (initial or follow-up run). |
| In Review | `states.inReview` | Agent, when it starts `/sreview` (the orchestrate skill's rule). |
| To Review | `states.toReview` | sapphire-agent, once the result is posted for the open or merged PR. A follow-up request is claimed only here. |
| Shipped | `states.shipped` | Not this code. Linear's GitHub integration on merge. |

Linear's GitHub automation (team settings) must be: PR opened to To Review, merged to Shipped, branch or start to no action. A "start" rule moving to In Progress would pull the epic back out of To Review.

Sub-issue columns (moved by the agent, per `~/.claude/skills/orchestrate/SKILL.md`):

- **Implementing** when it starts a sub-issue.
- **Done** when that slice is verified. sapphire-agent does not check this state exists; the agent fails to move sub-issues if it doesn't.

## Things worth knowing up front

- Every role in `states` must exist in a team's workflow, including `shipped`, which sapphire-agent never sets. A team missing one is skipped and logged once.
- An epic is claimed only once it is `dispatchSettleSeconds` old (it is often created before its sub-issues). One without sub-issues runs `/orchestrate ... inline`.
- Only issues with no parent count as epics.
- Order is Linear board order (`sortOrder` ascending); at most `maxInFlight` runs at once, follow-ups first.
- The agent opens and pushes the PR as the user's account. What sapphire-agent writes on GitHub (thread replies and resolves, `Addressed your concerns inline.`, a command's replies and failures, thumbs-ups on mentions) is the GitHub App's (`<slug>[bot]`). The bot (`@<bot.login>`) is mentioned to ask for something. On Linear it writes `PR opened: <url>`, the `agent-stuck` label and every notice about the epic, as comments.
- Linear and GitHub are the source of truth. The journal only holds what cannot be observed (see `journal-and-markers.md`); every comment, notices included, carries a hidden marker, so none is posted twice.

## The prompts the agent gets

Built by the `Prompts` service, each on one line:

`/orchestrate Linear epic <ID> autonomously`, with `inline` before `autonomously` when the epic has no sub-issues, and `, reply-to <session>` after it when the run was dispatched with `sapphire dispatch --reply-to`.

`/follow-up Linear epic <ID>, PR <pr url>, threads <id1> <id2> ... (or: no threads), instruction "<text>" (when one was given)`

A command agent gets one line naming it (`CMD-<n>`), the author, the comment's URL and its text quoted as JSON, the `ctl.sh` subcommands, what it may read, and that it replies, then runs `done CMD-<n>` (`Prompts.command`).

The workflow lives in the skills, not in this code:

- Orchestrate (`~/.claude/skills/orchestrate/SKILL.md`, sections **Linear epics** and **Autonomous runs**): move sub-issues to Implementing and Done and the epic to In Review at `/sreview`; a subagent that ends with `HANDOFF <path>` has its slice restarted by a fresh subagent with the doc. `autonomously` means: commit each verified slice, run `/pr` after `/sreview`, self-review and push fixes, write the result file, never post to GitHub; on a question, with `reply-to` send it as one line `<ID>: <question>` to that session (`SendMessage`) and end the turn to wait for the reply, otherwise comment it on the epic and stop.
- Follow-up (`~/.claude/skills/follow-up/SKILL.md`): reads the sub-issues, earlier PR summaries and the threads, makes and pushes the changes (and what the instruction asks), self-reviews as orchestrate does, and writes the result file with exactly one reply per thread id (none without threads). It never posts to GitHub and never moves the epic. A question goes to the session its prompt names with `reply-to`, as in orchestrate; a follow-up prompt names none, so it is commented on the epic.

Changing the column names means editing those skills as well as `states` in the config.
