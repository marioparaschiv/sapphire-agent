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
- Unit `PATH` is `/usr/local/bin:/usr/bin:/bin`; `git` and `gh` must be there. `gh` must be logged in as the user. The bot's comments are posted by the GitHub App (below), with no `gh` login.
- The service listens for the App's webhook deliveries on `127.0.0.1:<bot.app.webhookPort>` (default 3790) while it runs (Webhook below).
- A command agent runs `node` through `scripts/ctl.sh` in its tab's shell, so `node` (24) must be on the user's shell `PATH`.

## Install

`sh scripts/install.sh` (idempotent):

1. `herdr plugin link ~/herdr-linear`.
2. Copy both units to `~/.config/systemd/user/`.
3. `systemctl --user daemon-reload` and `enable` both.

Editing a file in `systemd/` does nothing until you rerun the install (or copy it) and `daemon-reload`.

## GitHub App

Mentions of the bot reach the service as the GitHub App's webhook deliveries, and the bot's comments (command replies, `ctl.sh reply`, failure notices) are posted by the App and show as `<slug>[bot]`. It is created and installed by hand:

1. Create it under GitHub Settings, Developer settings, GitHub Apps. Permissions: Issues read and write, Pull requests read and write, Contents read, Metadata read. Events: Issue comment, Pull request review, Pull request review comment. Webhook URL `https://herdr.marioparaschiv.com/github`, with a webhook secret.
2. Save the webhook secret as `$HERDR_PLUGIN_CONFIG_DIR/webhook-secret` and generate a private key in its settings and save it as `$HERDR_PLUGIN_CONFIG_DIR/app.pem`, both with `chmod 600`. Put the App ID and both paths in `bot.app` (`config.md`).
3. Install it (its public page, Install) on every repo the bot should answer on. Only installed repos send deliveries, and a reply on a repo without the installation fails with `GitHub answered HTTP 404 to GET /repos/<owner>/<name>/installation: Not Found`.

For each comment the service signs a JWT with the key (RS256, `iat` 60 s back, `exp` 10 min after that), looks up the repo's installation, and mints an installation token, which it reuses until 5 min before it expires (tokens last an hour); `gh` gets it as `GH_TOKEN`. Tokens live in memory only, so a restart mints new ones. Everything else on GitHub stays on the user's `gh` login.

## Webhook

nginx terminates TLS for `https://herdr.marioparaschiv.com` with the `*.marioparaschiv.com` Cloudflare origin certificate and forwards only `/github` to `127.0.0.1:3790` (the site config was drafted at `/tmp/herdr-github.conf`; installing it, the DNS record and reloading nginx need sudo). Every other path gets 404.

The service answers each delivery:

| Status | When |
| --- | --- |
| 204 | A mention was recorded as a command (or was there already), or the event or action is not one it handles, or the comment does not ask the bot. |
| 400 | A handled event whose payload does not match its schema. |
| 401 | The `X-Hub-Signature-256` header is missing or does not match the webhook secret. |
| 500 | The command could not be recorded (journal error). |

A delivery that failed (500, or the service down so nginx answered 502) is not redelivered by GitHub on its own: redeliver it from the App's settings (Advanced, Recent Deliveries). Redelivering one that succeeded already starts nothing.

## Plugin manifest (`herdr-plugin.toml`)

- `[[startup]]` runs `scripts/ensure-running.sh` = `systemctl --user start herdr-linear.service`. herdr runs startup hooks once and does not supervise them; systemd keeps the service alive.
- Actions (global context): `pause`, `resume`, `status`, each `sh scripts/ctl.sh <action>`.

## ctl.sh

The command agent's tools, and the operator's:

```sh
sh ~/herdr-linear/scripts/ctl.sh pause                       # touch $STATE/paused
sh ~/herdr-linear/scripts/ctl.sh resume                      # rm $STATE/paused
sh ~/herdr-linear/scripts/ctl.sh status                      # paused?, service state, runs, commands, requests
sh ~/herdr-linear/scripts/ctl.sh start HL-14                 # move the epic to its ready state
sh ~/herdr-linear/scripts/ctl.sh stop HL-12                  # end its run, close its tab
sh ~/herdr-linear/scripts/ctl.sh send HL-9 Use the existing helper.
sh ~/herdr-linear/scripts/ctl.sh follow-up HL-9 Rename it --threads PRRT_kwDO1 --threads PRRT_kwDO2
sh ~/herdr-linear/scripts/ctl.sh reply <comment-url> Done.   # as the App; only on a command's comment
sh ~/herdr-linear/scripts/ctl.sh done CMD-3                  # the command agent is done
```

- Pause stops new runs only: no ready epic and no follow-up is claimed. Claimed runs still start, runs in flight are still watched, results are still posted, worktrees still cleaned up, and mentions still run commands (so `resume` can come in as one).
- `pause`, `resume` and every recorded request write `$STATE/wake`, which makes the service tick at once; the log prints `dispatching paused` / `dispatching resumed`.
- `status`, `start` to `done` run `node src/ctl.ts`, which reads `$HERDR_PLUGIN_CONFIG_DIR/config.json`, the Linear key, the App's private key and webhook secret, and the journal (env defaults as in the unit). `stop`, `send`, `follow-up`, `reply` and `done` only record a request the service acts on (`rules.md`); `start` moves the epic in Linear itself. A refusal (no such run, not a command's comment) goes to stderr with exit code 1.
- `status` prints one line per run (identifier, status, job, the epic's Linear state, claim time, tab, worktree, or `no runs`), then the commands queued or in flight (or `no commands`), then the requests waiting.
- `pause`, `resume` and `status` are also herdr plugin actions.

## Drain

To get to a state with nothing in flight (before a risky deploy, or before stopping the service for a while):

1. `ctl.sh pause`.
2. Wait until `ctl.sh status` shows no run `claimed`, `running`, `awaitingInput` or `stale`. Answer or start over flagged runs as needed (`rules.md`).
3. Do what you needed; `ctl.sh resume` afterwards.

`ended` and `kept` runs may stay: they hold no agent, only cleanup and follow-up bookkeeping. A command agent may still run after the pause (they are not paused); it is done within minutes or fails by itself.

## Cutover from the old dispatcher

The old dispatcher kept its runs in `$STATE/claims.json`; the reconciler does not read it and there is no importer. On startup it refuses to run while that file still holds claims, with: `<path> still holds N claims of the old dispatcher. Drain it first: pause it (scripts/ctl.sh pause), wait until no run is in flight, then delete <path>.` The service then exits and systemd retries every 30 s, so nothing runs until the file is gone.

1. Pause the old dispatcher: `sh scripts/ctl.sh pause`.
2. Wait until nothing is in flight: `claims.json` holds no claim in `claimed`, `running`, `awaitingInput` or `stale` (the old `ctl.sh status` prints it).
3. Deploy: add `"allowedUsers": ["marioparaschiv"]` to `bot` in the config (`config.md`), update `~/herdr-linear` to the new code and restart the service (only when the user asks).
4. Delete `$STATE/claims.json`. The next restart starts the reconciler.
5. `sh scripts/ctl.sh resume`.

After the cutover, epics the old dispatcher left in To Review have no journal row, so a follow-up cannot be asked for on their PRs; handle those threads by hand. Their worktrees are removed by the orphan worktree sweep once the epic is finished (Shipped or another completed or canceled state), unless they hold unsaved work.

## Logs and state

- Logs: `journalctl --user -u herdr-linear -f` (stdout). Lines carry `epic=<IDENTIFIER>` and `rule=<name>` annotations.
- Logs of a command carry `task=CMD-<n>`. Logs of a webhook delivery carry `delivery=<X-GitHub-Delivery>`: `queued the mention by @<login> in <url>`, `ignored the mention ...`, `refused a delivery ...`, `cannot handle the delivery`.
- State dir: `~/.local/state/herdr/plugins/herdr-linear/` holds `journal.db`, `paused` and `wake`.
- Run tabs: herdr workspace `agents`, tab `<IDENTIFIER> <title>`; command tabs `@bot CMD-<n>`.
- Worktrees: `~/.herdr/worktrees/<repo>/<branch-slug>`. Removed with the local branch once the epic is Shipped or its PR is merged or closed, unless they hold unpushed work (then the epic gets a comment with the path).

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Service crash-loops with `StartupError: cannot start, fix these and restart:` | Fix every listed problem (Linear key, App key or webhook secret file missing, empty or not mode 600, invalid config field, missing env var); see `config.md`. |
| Service crash-loops with `GitHub answered HTTP 401 to GET /app` | `bot.app.id` and the private key do not belong to the same App, or the key was revoked. Generate a new key (GitHub App above). |
| Service crash-loops with `... still holds N claims of the old dispatcher` | Finish the cutover (above). |
| Service crash-loops with a `ServeError` | Another process holds `bot.app.webhookPort` (`ss -ltnp 'sport = :3790'`). |
| `team X has no workflow state "..."; skipping it until it does` | Add the named states to that team in Linear (or change `states` in config). Picked up on the next tick, but the log line is printed only once per process and nothing is logged when it recovers. |
| `team X not found in Linear` | The config key must equal the team's exact name. |
| Epic in Ready never picked up | Paused? No sub-issues (logged once)? Has `agent-stuck`? `maxInFlight` used up, maybe by an `awaitingInput` run or one whose agent is still working? Team skipped? |
| A mention of the bot does nothing | `ctl.sh status`: is the command `queued` behind another? Is its author in `bot.allowedUsers` (an `ignored` command shows only in the journal)? Is `@<bot.login>` a whole word, and the comment not posted through the agent (onBehalfOf block)? Is the App installed on the repo? Its Recent Deliveries show each delivery's response: 401 means the webhook secret differs from `bot.app.webhookSecretFile`, 502 that nginx could not reach the service, 500 a journal error (`cannot handle the delivery` in the log); redeliver it once fixed. |
| A follow-up was asked for but does not start | `ctl.sh status` shows the request waiting: paused? `maxInFlight` used up? Epic has `agent-stuck`, or is not in To Review? Its run must be `ended`; it waits while one is in flight. A request whose epic has no run is dropped. |
| A command failed | The App replied on the issue or PR with the reason and the pane tail. Mention the bot again. |
| A command's reply never shows up | Look for `cannot reply on` or `GitHub answered HTTP` in the log. A 404 for `/installation` means the App is not installed on that repo (GitHub App above). |
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
