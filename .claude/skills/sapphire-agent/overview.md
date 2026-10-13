# Overview

## Flow

1. Human moves an epic (top-level issue) to **Ready For Agent**, or runs `sapphire dispatch <ID>` (the `/dispatch` skill).
2. Dispatch claims it; start launches its T3 thread and moves it to **Implementing**.
3. Agent works the sub-issues, moves the epic to **In Review** at `/sreview`, runs `/pr`, self-reviews, writes its result file.
4. Once it stops, results posts `PR opened: <url>`, the summary and unfixed flags, and moves the epic to **To Review**.
5. Human reviews the PR (GitHub or Linear's review UI) and mentions the bot (`@<bot.login>`, e.g. `@orchestratorbot`) in plain language.
6. The webhook server records a command; the commands rule starts a supervised read-only command agent, which replies as the bot (`ctl.sh reply`), asks for a follow-up (`ctl.sh follow-up <EPIC> <instruction> --threads <id>...`) and runs `done`.
7. Follow-up claims a run; start pulls the branch and launches `/follow-up` in the epic's worktree (**Implementing**).
8. The follow-up agent pushes changes and writes one reply per thread; results posts and resolves each thread, comments `Addressed your concerns inline.`, posts the summary, moves the epic to **To Review**.
9. Once the PR is merged or closed (or the epic Shipped), cleanup settles the thread and removes worktree, local branch and run.

A mention can ask for anything the CLI does ("pause everything", "stop HL-12", "dispatch HL-14", "tell the HL-9 agent ...", "what is running?"). Stalls, questions and context handoffs: `rules.md`.

## Columns

| Column | Config key | Moved in by |
| --- | --- | --- |
| To Do | none | Human; never read or set by the service. |
| Ready For Agent | `states.ready` | Human or `sapphire dispatch`. A run that never started leaves its epic here. |
| Implementing | `states.implementing` | Service, once a run's thread is launched (initial or follow-up). |
| In Review | `states.inReview` | Agent, when it starts `/sreview`. |
| To Review | `states.toReview` | Service, once the result is posted. Follow-ups are claimed only here. |
| Shipped | `states.shipped` | Linear's GitHub integration on merge; never set by the service. |

Linear's GitHub automation (team settings) must be: PR opened to To Review, merged to Shipped, branch/start to no action (a start rule moving to In Progress pulls the epic out of To Review).

Sub-issues are moved by the agent: Implementing when started, Done when verified. The service does not check Done exists; the agent fails to move sub-issues without it.

Renaming columns means editing the orchestrate and follow-up skills as well as `states`.

## Who writes what

The agent pushes and opens the PR as the user's account and never posts to GitHub. The service writes on GitHub only as the GitHub App (`<slug>[bot]`): thread replies and resolves, `Addressed your concerns inline.`, a command's replies and failures, thumbs-ups on mentions. On Linear it writes `PR opened: <url>`, the `agent-stuck` label and every notice.

## Prompts

Built by `Prompts`, each one line:

- `/orchestrate Linear epic <ID> autonomously`; `inline` before `autonomously` when the epic has no sub-issues; `, reply-to <session>` appended when dispatched with `--reply-to`.
- `/follow-up Linear epic <ID>, PR <url>, threads <id1> <id2> ... (or: no threads), instruction "<text>"` (instruction only when given).
- Command agent: see `rules.md` (Commands).

The workflow lives in the skills, not this code:

- Orchestrate (`~/.claude/skills/orchestrate/SKILL.md`, **Linear epics** and **Autonomous runs**): moves sub-issues and the epic as above; restarts a subagent's slice that ended `HANDOFF <path>` with a fresh one and the doc. `autonomously`: commit each verified slice, `/pr` after `/sreview`, self-review and push fixes, write the result file. A question goes to the `reply-to` session as one line `<ID>: <question>` (`SendMessage`) and the turn ends to wait; without `reply-to` it is commented on the epic and the agent stops.
- Follow-up (`~/.claude/skills/follow-up/SKILL.md`): reads sub-issues, earlier PR summaries and threads, pushes the changes, self-reviews, writes the result file with exactly one reply per thread id. Never moves the epic. Its prompt has no `reply-to`, so questions go on the epic.
