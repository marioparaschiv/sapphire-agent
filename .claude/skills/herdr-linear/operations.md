# Operations

How the live dispatcher is installed, started, paused, inspected and unstuck on this machine.

## Processes

| Unit (`~/.config/systemd/user/`) | Source | Does |
| --- | --- | --- |
| `herdr-linear.service` | `systemd/herdr-linear.service` | Runs `node src/main.ts` in `~/herdr-linear`. `Restart=always`, `RestartSec=30`. `Wants`/`After` herdr-server. |
| `herdr-server.service` | `systemd/herdr-server.service` | Runs `herdr server`, but only if none is running. |

- herdr also starts its server on demand when a client attaches. `ExecCondition` runs `herdr status server` and skips the start if it prints `status: running`, so systemd never starts a second server. `inactive` for this unit is normal when herdr was started another way.
- `ExecStart` pins `~/.nvm/versions/node/v24.21.0/bin/node`. Update both units after a Node upgrade.
- Apply config or code changes with `systemctl --user restart herdr-linear` (only when the user asks). In-flight claims re-attach on start.
- Unit `PATH` is `/usr/local/bin:/usr/bin:/bin`; `git` and `gh` must be there.

## Install

`sh scripts/install.sh` (idempotent):

1. `herdr plugin link ~/herdr-linear`.
2. Copy both units to `~/.config/systemd/user/`.
3. `systemctl --user daemon-reload` and `enable` both.

Editing a file in `systemd/` does nothing until you rerun the install (or copy it) and `daemon-reload`.

## Plugin manifest (`herdr-plugin.toml`)

- `[[startup]]` runs `scripts/ensure-running.sh` = `systemctl --user start herdr-linear.service`. herdr runs startup hooks once and does not supervise them; systemd keeps the dispatcher alive.
- Actions (global context): `pause`, `resume`, `status`, each `sh scripts/ctl.sh <action>`.

## Pause, resume, status

```sh
sh ~/herdr-linear/scripts/ctl.sh pause    # touch $STATE/paused
sh ~/herdr-linear/scripts/ctl.sh resume   # rm $STATE/paused
sh ~/herdr-linear/scripts/ctl.sh status   # paused?, service state, claims.json
```

- Pause stops new dispatches only. Claims keep being reconciled; PRs still move epics to To Review.
- Takes effect on the next tick; the log prints `dispatching paused` / `dispatching resumed`.
- Same three are available as herdr plugin actions.

## Logs and state

- Logs: `journalctl --user -u herdr-linear -f` (stdout). Worker lines start with `worker:`.
- State dir: `~/.local/state/herdr/plugins/herdr-linear/` holds `claims.json` and `paused`.
- Run tabs: herdr workspace `agents`, tab `<IDENTIFIER> <title>`.
- Worktrees: `~/.herdr/worktrees/<repo>/<branch-slug>`. Never cleaned up by the plugin.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `team X has no workflow state "..."; skipping it until it does` | Add the named states to that team in Linear (or change `states` in config). Picked up on the next tick, but the log line is printed only once per process and nothing is logged when it recovers. |
| `team X not found in Linear` | Config key must equal the team's exact name. |
| Service crash-loops on startup | `journalctl` shows the reason: key file missing/empty/mode (`chmod 600 ~/.config/herdr-linear/linear-key`), invalid config field, missing env var. |
| Epic in Ready never picked up | Paused? No sub-issues (logged once)? Has `agent-stuck`? `maxInFlight` used up, maybe by a `stuck` claim? Team skipped? |
| Epic has `agent-stuck` | Read the epic comment. Retry rules: `claims-and-lifecycle.md`. |

Retry quick reference:

- Failed to start: fix the cause, remove `agent-stuck`.
- Stuck: answer the agent in its tab, or move the epic to Ready and remove the label.

## Don't

- Don't `systemctl --user stop/restart herdr-server` or `herdr server stop`: it kills every agent pane. Running claims then report `vanished` and get flagged.
- Don't hand-edit `claims.json` while the service runs; it holds claims in memory and overwrites the file.
