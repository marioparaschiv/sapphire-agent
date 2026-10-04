---
name: herdr-linear
description: Use when working on, debugging, or operating the herdr-linear plugin, the Linear epic reconciler that starts Claude Code runs in herdr tabs and keeps Linear states in sync. Covers the reconciler and its rules, the journal and markers, the failure policy, herdr/git/Linear/GitHub integration, config, systemd operation, cutover and development workflow.
---

# herdr-linear

A herdr plugin plus systemd user service that watches Linear for epics in "Ready For Agent", starts a Claude Code `/orchestrate` run for each in its own git worktree and herdr tab, and moves the epic through Linear as the run progresses. A GitHub comment that mentions the bot (`@orchestratorbot`), by a user in `bot.allowedUsers`, reaches the service as a GitHub App webhook delivery and starts a command agent: Claude locked down to `scripts/ctl.sh` and read-only `gh` and `git`, which reads the request in plain language and acts on it (status, pause, start or stop an epic, message a run's agent, ask for a `/follow-up` run that changes the PR, reply as the GitHub App). It is written on Effect 4 as one level-triggered reconciler: every tick it observes Linear, herdr, git and GitHub, compares that with a small local journal, and acts.

Repo: `~/herdr-linear`. Read only the files you need.

| File | Covers | Read when |
| --- | --- | --- |
| `overview.md` | End-to-end flow, Linear columns, who moves what (plugin, agent, human, GitHub integration), the prompts. | First time on the project, or changing how epics move between Linear states. |
| `architecture.md` | The reconciler, one tick (observation, planner, rules in order), the services and their test layers, startup, file map. | Finding which module owns what, adding a rule or a service, or touching `main.ts`. |
| `rules.md` | Run statuses and `maxInFlight`, each rule (requests, cleanup, results, monitoring, follow-up, dispatch, start, commands), mentions from webhook deliveries, flags, question relay, tab close, ownership and orphans, the command agent and its lockdown, retrying, known limits. | Changing reconcile logic, or debugging why an epic was (not) picked up, flagged, ended or cleaned up, or why a mention did (not) do something. |
| `journal-and-markers.md` | The SQLite journal (tables, what it holds and why), markers on Linear and GitHub comments and their keys, crash safety. | Changing what is stored or written, or debugging a double post or a skipped step. |
| `failure-policy.md` | Transient and Permanent errors, timeouts, retries, Retry-After, flagging failing epics, per-epic fibers, semaphores. | Touching an external call, or debugging an epic flagged for failures. |
| `herdr-and-git.md` | Starting a run (worktree, trust, tab, `herdr agent start`), the Herdr, Git and ClaudeTrust services, herdr events. | Changing how runs start or are watched, or debugging a run that failed to start or went unnoticed. |
| `linear-api.md` | The Linear and GitHub services: operations, state and label resolution, repo labels, PR detection, GitHub writes. | Touching `linear.ts` or `github.ts`, or debugging Linear errors, missing states, labels or PR detection. |
| `config.md` | Config file location, every field and default, team-to-repo mapping, API key file, env vars, startup errors. | Editing config, adding a team or repo, or a startup failure. |
| `operations.md` | systemd units, install, plugin manifest, the `ctl.sh` subcommands, drain, cutover, logs, state dir, troubleshooting. | Operating the live service, deploying, reading logs, or retrying a flagged epic. |
| `development.md` | Commands, Node 24 type stripping, Effect conventions, the test harness, fakes and fixtures, style, testing against herdr safely. | Before changing any code or running anything against herdr. |

Rules that apply everywhere:

- Never stop or restart the default herdr session or the live systemd services as a side effect. See `development.md`.
- Don't push. Commit only when asked.
