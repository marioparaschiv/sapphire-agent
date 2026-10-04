---
name: herdr-linear
description: Use when working on, debugging, or operating the herdr-linear plugin, the Linear epic dispatcher that starts Claude Code runs in herdr tabs and keeps Linear states in sync. Covers code layout, claim lifecycle, herdr/git/Linear integration, config, systemd operation and development workflow.
---

# herdr-linear

A herdr plugin plus systemd user service that polls Linear for epics in "Ready For Agent", starts a Claude Code `/orchestrate` run for each in its own git worktree and herdr tab, and moves the epic through Linear as the run progresses.

Repo: `~/herdr-linear`. Read only the files you need.

| File | Covers | Read when |
| --- | --- | --- |
| `overview.md` | End-to-end flow, Linear columns, who moves what (plugin, agent, human, GitHub integration). | First time on the project, or changing how epics move between Linear states. |
| `architecture.md` | Dispatcher vs worker split, protocol messages, in-process wiring in `main.ts`, remote-worker seam, file map. | Adding a message, touching `main.ts`, planning the remote worker, or finding which file owns what. |
| `claims-and-lifecycle.md` | Claim statuses, `claims.json`, per-tick reconcile rules, stuck detection, failure path, retry, restart re-attach. | Changing dispatch/reconcile logic, or debugging why an epic was (not) picked up, flagged or released. |
| `worker-and-herdr.md` | Worktree creation, Claude trust pre-accept, tab/workspace creation, `herdr agent start` quirks, event subscription. | Changing how runs start or are watched, or debugging a run that failed to start or went unnoticed. |
| `linear-api.md` | GraphQL queries and mutations, per-team state resolution, labels and repo labels, PR detection via `gh`. | Touching `linear.ts` or `github.ts`, or debugging Linear errors, missing states, labels or PR detection. |
| `config.md` | Config file location, every field and default, team-to-repo mapping, API key file, env vars. | Editing config, adding a team or repo, or a startup failure about config or the key. |
| `operations.md` | systemd units, install, plugin manifest, pause/resume/status, logs, state dir, troubleshooting. | Operating the live service, reading logs, retrying a stuck epic, or fixing a skipped team. |
| `development.md` | Node 24 type stripping, tests, typecheck, code style, safe herdr testing, commit rules. | Before changing any code or running anything against herdr. |

Rules that apply everywhere:

- Never stop or restart the default herdr session or the live systemd services as a side effect. See `development.md`.
- Don't push. Commit only when asked.
