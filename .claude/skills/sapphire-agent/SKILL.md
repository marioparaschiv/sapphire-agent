---
name: sapphire-agent
description: Use when working on, debugging, or operating the sapphire-agent service, the Linear epic reconciler that starts Claude Code runs as T3 Code threads and keeps Linear states in sync. Covers the reconciler and its rules, the journal and markers, the failure policy, T3/git/Linear/GitHub integration, config, systemd operation, cutover and development workflow.
---

# sapphire-agent

A systemd user service that watches Linear for epics in "Ready For Agent", starts a Claude Code `/orchestrate` run for each in its own git worktree, as a full-access T3 Code thread, and moves the epic through Linear as the run progresses. A GitHub comment that mentions the bot (`@orchestratorbot`), by a user in `bot.allowedUsers`, reaches the service as a GitHub App webhook delivery and starts a command agent: a supervised T3 thread kept to `scripts/ctl.sh` and read-only `gh` and `git`, which reads the request in plain language and acts on it (status, pause, start or stop an epic, message a run's agent, ask for a `/follow-up` run that changes the PR, reply as the bot on the issue or PR). Status updates about an epic (flags, summaries, failures) are notices, posted as comments on the epic in Linear; what the service says about itself (it cannot observe, or cannot read its pause file) goes to the user's phone through Pushover, and so does a run that stalls, waits for input, ends its turn or leaves unsaved work. It is written on Effect 4 as one level-triggered reconciler: every tick it observes Linear, T3, git and GitHub, compares that with a small local journal, and acts.

Repo: `~/sapphire-agent`. Read only the files you need.

| File | Covers | Read when |
| --- | --- | --- |
| `overview.md` | End-to-end flow, Linear columns, who moves what (sapphire-agent, agent, human, GitHub integration), the prompts. | First time on the project, or changing how epics move between Linear states. |
| `architecture.md` | The reconciler, one tick (observation, planner, rules in order), the webhook and agent event servers, Pushover outages, the services and their test layers, startup, the CLI, file map. | Finding which module owns what, adding a rule or a service, or touching `main.ts`. |
| `rules.md` | Run statuses and `maxInFlight`, each rule (requests, cleanup, results, monitoring, handoff, follow-up, dispatch, start, commands, notices), mentions from webhook deliveries, agent events and context handoffs, flags, ownership and orphans, the command agent and its guard, retrying, known limits. | Changing reconcile logic, or debugging why an epic was (not) picked up, flagged, ended or cleaned up, or why a mention did (not) do something. |
| `journal-and-markers.md` | The SQLite journal (tables, migrations, what it holds and why), markers on Linear and GitHub comments and on notices, and their keys, crash safety. | Changing what is stored or written, or debugging a double post or a skipped step. |
| `failure-policy.md` | Transient and Permanent errors, timeouts, retries, Retry-After, flagging failing epics, outages sent to Pushover, per-epic fibers, semaphores. | Touching an external call, or debugging an epic flagged for failures. |
| `t3-and-git.md` | Starting a run as a T3 thread, the worktrees T3 makes, the Git service, the result file. | Changing how runs start or are watched, or debugging a run that failed to start or went unnoticed. |
| `linear-api.md` | The Linear and GitHub services: operations, state and label resolution, repo labels, PR detection, the few Linear and GitHub writes. | Touching `linear.ts` or `github.ts`, or debugging Linear errors, missing states, labels or PR detection. |
| `config.md` | Config and state directories, every field and default, projects (`sapphire project`, the one-time import of `teams`), API key and secret files (Pushover included), env vars, startup errors. | Editing config, adding a project or repo, or a startup failure. |
| `operations.md` | the systemd unit, install, Claude hooks, the `sapphire` subcommands (`dispatch` and `project` included), drain, cutover, logs, state dir, troubleshooting. | Operating the live service, deploying, reading logs, or retrying a flagged epic. |
| `development.md` | Commands, Node 24 type stripping, Effect conventions, the test harness, fakes and fixtures, style, working safely next to the live service. | Before changing any code or running anything against the live T3 server. |

Rules that apply everywhere:

- Never stop or restart the live systemd service, or make write calls to the live T3 server, as a side effect. See `development.md`.
- Don't push. Commit only when asked.
