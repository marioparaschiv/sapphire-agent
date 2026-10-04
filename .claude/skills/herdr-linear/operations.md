# Operations

How the live service is installed, started, paused, drained, deployed, inspected and unstuck on this machine.

## Processes

| Unit (`~/.config/systemd/user/`) | Source | Does |
| --- | --- | --- |
| `herdr-linear.service` | `systemd/herdr-linear.service` | Runs `node src/main.ts` in `~/herdr-linear`. `Restart=always`, `RestartSec=30`. `Wants`/`After` herdr-server. |
| `herdr-server.service` | `systemd/herdr-server.service` | Runs `herdr server`, but only if none is running. |

- herdr also starts its server on demand when a client attaches. `ExecCondition` runs `herdr status server` and skips the start if it prints `status: running`, so systemd never starts a second server. `inactive` for this unit is normal when herdr was started another way.
- `ExecStart` pins `~/.nvm/versions/node/v24.21.0/bin/node`. Update both units after a Node upgrade.
- Apply config or code changes with `systemctl --user restart herdr-linear` (only when the user asks). Nothing is lost: the next tick observes the world again and the journal carries the rest.
- Unit `PATH` is `/usr/local/bin:/usr/bin:/bin`; `git` and `gh` must be there. `gh` must be logged in as the user by default and as the bot in `bot.ghConfigDirectory` (`GH_CONFIG_DIR=<dir> gh auth login`).

## Install

`sh scripts/install.sh` (idempotent):

1. `herdr plugin link ~/herdr-linear`.
2. Copy both units to `~/.config/systemd/user/`.
3. `systemctl --user daemon-reload` and `enable` both.

Editing a file in `systemd/` does nothing until you rerun the install (or copy it) and `daemon-reload`.

## Plugin manifest (`herdr-plugin.toml`)

- `[[startup]]` runs `scripts/ensure-running.sh` = `systemctl --user start herdr-linear.service`. herdr runs startup hooks once and does not supervise them; systemd keeps the service alive.
- Actions (global context): `pause`, `resume`, `status`, each `sh scripts/ctl.sh <action>`.

## Pause, resume, status

```sh
sh ~/herdr-linear/scripts/ctl.sh pause    # touch $STATE/paused
sh ~/herdr-linear/scripts/ctl.sh resume   # rm $STATE/paused
sh ~/herdr-linear/scripts/ctl.sh status   # paused?, service state, the runs in the journal
```

- Pause stops new runs only: no ready epic and no follow-up is claimed. Claimed runs still start, runs in flight are still watched, results are still posted and worktrees still cleaned up.
- Takes effect on the next tick; the log prints `dispatching paused` / `dispatching resumed`.
- `status` runs `node src/status.ts`, which reads the journal and prints one line per run: identifier, status, job, claim time, tab and worktree (or `no runs`).
- Same three are available as herdr plugin actions.

## Drain

To get to a state with nothing in flight (before a risky deploy, or before stopping the service for a while):

1. `ctl.sh pause`.
2. Wait until `ctl.sh status` shows no run `claimed`, `running`, `awaitingInput` or `stale`. Answer or start over flagged runs as needed (`rules.md`).
3. Do what you needed; `ctl.sh resume` afterwards.

`ended` and `kept` runs may stay: they hold no agent, only cleanup and follow-up bookkeeping.

## Cutover from the old dispatcher

The old dispatcher kept its runs in `$STATE/claims.json`; the reconciler does not read it and there is no importer. On startup it refuses to run while that file still holds claims, with: `<path> still holds N claims of the old dispatcher. Drain it first: pause it (scripts/ctl.sh pause), wait until no run is in flight, then delete <path>.` The service then exits and systemd retries every 30 s, so nothing runs until the file is gone.

1. Pause the old dispatcher: `sh scripts/ctl.sh pause`.
2. Wait until nothing is in flight: `claims.json` holds no claim in `claimed`, `running`, `awaitingInput` or `stale` (the old `ctl.sh status` prints it).
3. Deploy: update `~/herdr-linear` to the new code and restart the service (only when the user asks).
4. Delete `$STATE/claims.json`. The next restart starts the reconciler.
5. `sh scripts/ctl.sh resume`.

After the cutover, epics the old dispatcher left in To Review have no journal row, so threads that mention the bot on their PRs start no follow-up; handle those threads by hand. Their worktrees are removed by the orphan worktree sweep once the epic is finished (Shipped or another completed or canceled state), unless they hold unsaved work.

## Logs and state

- Logs: `journalctl --user -u herdr-linear -f` (stdout). Lines carry `epic=<IDENTIFIER>` and `rule=<name>` annotations.
- State dir: `~/.local/state/herdr/plugins/herdr-linear/` holds `journal.db` and `paused`.
- Run tabs: herdr workspace `agents`, tab `<IDENTIFIER> <title>`.
- Worktrees: `~/.herdr/worktrees/<repo>/<branch-slug>`. Removed with the local branch once the epic is Shipped or its PR is merged or closed, unless they hold unpushed work (then the epic gets a comment with the path).

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Service crash-loops with `StartupError: cannot start, fix these and restart:` | Fix every listed problem (key file missing, empty or not mode 600, invalid config field, missing env var); see `config.md`. |
| Service crash-loops with `... still holds N claims of the old dispatcher` | Finish the cutover (above). |
| `team X has no workflow state "..."; skipping it until it does` | Add the named states to that team in Linear (or change `states` in config). Picked up on the next tick, but the log line is printed only once per process and nothing is logged when it recovers. |
| `team X not found in Linear` | The config key must equal the team's exact name. |
| Epic in Ready never picked up | Paused? No sub-issues (logged once)? Has `agent-stuck`? `maxInFlight` used up, maybe by an `awaitingInput` run or one whose agent is still working? Team skipped? |
| A thread mentioning the bot on a PR in To Review starts no follow-up | Paused? `maxInFlight` used up? Epic has `agent-stuck`? Thread resolved, or the user's latest comment in it lacks `@<bot.login>`? For a PR-level request: did a bot comment come after it? The run must be `ended` in the journal (`ctl.sh status`); a `kept` run, or an epic from before the cutover, is not scanned. |
| Epic has `agent-stuck` | Read the epic comment. Retry rules: `rules.md`. |
| PR is up but the epic stays in Implementing | The agent wrote no result file yet. It is flagged `awaitingInput` once quiet. |
| `failed; retrying next tick` repeating for an epic | A Transient failure (network, timeout, rate limit, git lock). It retries every tick without double-posting, and comments once after `flagTransientAfterSeconds`. |
| `permanentFailure` comment mentioning HTTP 422 from a review | A flag's `line` is outside the diff. Post the findings by hand and move the epic to To Review, which ends the run. |

Retry quick reference:

- `startFailed`: fix the cause, remove `agent-stuck`.
- `awaitingInput`: reply to the question comment on the epic (typed into the pane), or answer in its tab. To start over (also for `error` and `stale`): move the epic to Ready and remove the label.

## Don't

- Don't `systemctl --user stop/restart herdr-server` or `herdr server stop`: it kills every agent pane. Running runs then show as `vanished` and get flagged.
- Don't edit `journal.db` by hand while the service runs. To forget a run, stop the service first; the next start observes everything again.
