---
name: sapphire-agent
description: sapphire-agent, the Linear epic reconciler that runs Claude Code as T3 Code threads. Use when working on its code, debugging why an epic, run or bot mention did (not) act, or operating, deploying or configuring the service.
---

# sapphire-agent

Repo `~/sapphire-agent`, an Effect 4 systemd user service. One level-triggered reconciler observes Linear, T3, git and GitHub every tick, compares that with a small SQLite journal, and acts: each epic in Ready For Agent gets a full-access `/orchestrate` T3 thread in its own worktree and is moved through Linear; a GitHub comment mentioning the bot starts a supervised command agent. Status about an epic is a notice (a comment on the epic in Linear); trouble with the service itself goes to Pushover.

Read only the files you need:

| File | Read when |
| --- | --- |
| `overview.md` | New to the project, or changing how epics move between Linear columns, who moves them, or the agent prompts. |
| `architecture.md` | Finding which module owns what, adding a rule or service, or touching startup, wakes or `main.ts`. |
| `rules.md` | Changing reconcile logic, or debugging why an epic, run, mention, command, handoff or guard did (not) act; retrying a flagged epic. |
| `journal-and-markers.md` | Changing what is stored or posted, or debugging a double post or skipped step. |
| `failure-policy.md` | Touching an external call, or debugging retries, a `transientFailure`/`permanentFailure`, or a Pushover outage. |
| `integrations.md` | Touching the Linear, GitHub, GitHub App, T3 or Git services: launches, worktrees, result file, state/label/repo resolution, PR detection. |
| `config.md` | Editing config, secrets or env vars, adding a project, or a `StartupError`. |
| `operations.md` | Operating the live service: install, hooks, T3 settings, webhooks, `sapphire` CLI, drain, cutover, logs, troubleshooting. |
| `development.md` | Before changing code or running anything: commands, conventions, tests, fakes, harness, dev instance. |

Never stop or restart the live systemd service, or make write calls to the live T3 server, as a side effect.
