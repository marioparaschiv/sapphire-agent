# Operations

How the live service is installed, started, paused, drained, deployed, inspected and unstuck on this machine.

## Processes

| Unit (`~/.config/systemd/user/`) | Source | Does |
| --- | --- | --- |
| `sapphire-agent.service` | `systemd/sapphire-agent.service` | Runs `node src/main.ts` in `~/sapphire-agent`. `Restart=always`, `RestartSec=30`. |

- `ExecStart` pins `~/.nvm/versions/node/v24.21.0/bin/node`. Update the unit after a Node upgrade.
- Apply config or code changes with `systemctl --user restart sapphire-agent` (only when the user asks). Nothing is lost: the next tick observes the world again and the journal carries the rest.
- Unit `PATH` is `~/.local/bin:/usr/local/bin:/usr/bin:/bin`; `git` and `gh` must be there. The unit sets only `PATH`; the config and state directories default in code (`config.md`). After changing the unit, reinstall it (`sh scripts/install.sh`) so systemd picks it up.
- The Pushover app token and user key files must exist (`config.md`); the service does not start without them. `gh` must be logged in as the user, for reads. Every comment is posted by the GitHub App (below), with no `gh` login.
- The service listens for the App's and Linear's webhook deliveries on `127.0.0.1:<bot.app.webhookPort>` (default 3790) while it runs (Webhook and Linear webhook below).
- A command agent runs `node` through `scripts/ctl.sh` in its T3 thread, so `node` (24) must be on the `PATH` T3 gives its agents.

## Install

`sh scripts/install.sh` (idempotent):

1. Symlink `~/.local/bin/sapphire` to `scripts/ctl.sh`, so `sapphire <subcommand>` works anywhere.
2. Copy the unit to `~/.config/systemd/user/`.
3. `systemctl --user daemon-reload` and `enable` it.

The Claude hooks are not installed by the script: `~/.claude/settings.json` has one `{ "type": "command", "command": "sapphire hook claude", "async": true, "timeout": 10 }` entry under each of `SessionStart`, `UserPromptSubmit`, `Stop`, `Notification` and `SessionEnd`, and one under `PostToolUse` for every tool, for the context handoffs (`rules.md`, Agent events). That one is not `async`, so what the hook prints (a subagent's handoff instruction) reaches the agent after its tool call:

```json
"PostToolUse": [
  { "hooks": [{ "type": "command", "command": "sapphire hook claude", "timeout": 10 }] }
]
```

The run guards (`rules.md`, Run guards and notices) need a `PreToolUse` entry that is not `async`, so Claude waits for the answer before the tool runs. The matcher keeps the other tools from paying for the hook:

```json
"PreToolUse": [
  { "matcher": "Bash|Write|Edit|MultiEdit|NotebookEdit", "hooks": [{ "type": "command", "command": "sapphire hook claude", "timeout": 10 }] }
]
```

Widen the `PostToolUse` entry only once the running service knows every tool: an older one refuses any tool but `Skill`, and the hook fails on each.

The same `PreToolUse` entry guards command threads (`rules.md`, Read-only guard): their `Bash` and file edits are answered by the hook; widening its matcher would also refuse their other tools but `Read`, `Grep`, `Glob` and `SendMessage`, at about 350 ms per tool call of every session.

## T3 settings

No T3 MCP tool reads or changes them, so set once by hand in T3 (they live in `~/.t3/userdata/settings.json`):

- For each project sapphire-agent dispatches to (each `sapphire project` repo and label repo), project settings, **Automatic worktree cleanup**: **Off**. Cleanup removes a run's worktree once every commit is on origin; T3's own cleanup (`storageCleanup`, e.g. "no commits beyond the default branch") could remove one under a run.
- **Settings → General**, **Auto-settle merged threads**: on (the default).
- **Settings → Notifications**, **Device Notifications**: on, with T3 Connect linked. T3 pushes a run finishing, failing or waiting for input to the phone; Pushover only carries the service's own notices.

At startup the service reads that file (`t3.settingsFile`) and sends one Pushover notice `T3's settings need a change for sapphire-agent` naming each project to fix. A project T3 has no project for yet is checked against the environment settings it will inherit. Command threads run in checkouts under `$STATE/commands`, which T3 does not manage.

Editing a file in `systemd/` does nothing until you rerun the install (or copy it) and `daemon-reload`.

## GitHub App

Mentions of the bot reach the service as the GitHub App's webhook deliveries, and everything the service writes on GitHub (thread replies and resolves, `Addressed your concerns inline.`, thumbs-ups on mentions) is the App's and shows as `<slug>[bot]`. It is created and installed by hand:

1. Create it under GitHub Settings, Developer settings, GitHub Apps. Permissions: Issues read and write, Pull requests read and write, Contents read, Metadata read. Events: Issue comment, Pull request review, Pull request review comment. Webhook URL `https://webhook.marioparaschiv.com/github`, with a webhook secret.
2. Save the webhook secret as `webhook-secret` in the config directory and generate a private key in its settings and save it as `app.pem` there, both with `chmod 600`. Put the App ID and both paths in `bot.app` (`config.md`).
3. Install it (its public page, Install) on every repo the bot should answer on. Only installed repos send deliveries, and a write on a repo without the installation fails with `GitHub answered HTTP 404 to GET /repos/<owner>/<name>/installation: Not Found`.

For each write the service signs a JWT with the key (RS256, `iat` 60 s back, `exp` 10 min after that), looks up the repo's installation, and mints an installation token, which it reuses until 5 min before it expires (tokens last an hour); `gh` gets it as `GH_TOKEN`. Tokens live in memory only, so a restart mints new ones. Reads stay on the user's `gh` login.

## Webhook

nginx terminates TLS for `https://webhook.marioparaschiv.com` with the `*.marioparaschiv.com` Cloudflare origin certificate and forwards only `/github` to `127.0.0.1:3790` (installing the site config, the DNS record and reloading nginx need sudo). Every other path gets 404.

The service answers each delivery:

| Status | When |
| --- | --- |
| 204 | A mention was recorded as a command (or was there already), or the event or action is not one it handles, or the comment does not ask the bot. |
| 400 | A handled event whose payload does not match its schema. |
| 401 | The `X-Hub-Signature-256` header is missing or does not match the webhook secret. |
| 500 | The command could not be recorded (journal error). |

GitHub does not redeliver a failed delivery (500, or the service down so nginx answered 502) on its own. Redeliver it by hand from the App's settings (Advanced, Recent Deliveries); redelivering one that succeeded already starts nothing.

## Linear webhook

Linear has no push API other than webhooks, which need a public HTTPS URL. Tailscale Funnel exposes only `/linear` of the webhook server. A signed delivery wakes the reconciler, so a change in Linear is acted on at once instead of at the next poll. Set it up once by hand:

1. Expose the path: `sudo tailscale funnel --bg --set-path /linear http://127.0.0.1:3790/linear`. If Funnel or HTTPS certificates are off for the tailnet, the command prints a link to turn them on. `tailscale funnel status` shows the public URL, `https://<machine>.<tailnet>.ts.net/linear`.
2. In Linear, Settings, API, Webhooks, create a webhook: label `sapphire-agent`, URL the public URL from step 1, data change events Issues and Comments, for all public teams.
3. Save the webhook's signing secret, shown on its page, as `linear-webhook-secret` in the config directory with `chmod 600`, and set `linearWebhookSecretFile` to that path (`config.md`).
4. `systemctl --user restart sapphire-agent`.

The service answers each Linear delivery:

| Status | When |
| --- | --- |
| 200 | The `Linear-Signature` header matches the Linear webhook secret; the reconciler was woken. |
| 401 | The `Linear-Signature` header is missing or does not match. Nothing else happens. |

A delivery carries no state for the service: it only asks for a tick, which reads Linear again. A delivery sent while the service is down is not replayed; the tick at startup and the `pollSeconds` backstop poll catch up instead. Logs of a Linear delivery carry `delivery=<Linear-Delivery>`.

## ctl.sh

The command agent's tools, and the operator's. `sapphire <action>` is the same as `sh ~/sapphire-agent/scripts/ctl.sh <action>`, and `sapphire ctl <action>` the same again. It needs no environment variables, so it works from any shell, a T3 thread included; the `/dispatch` skill (`~/.claude/skills/dispatch`) wraps `dispatch`, `status`, `stop`, `pause` and `resume`:

```sh
sh ~/sapphire-agent/scripts/ctl.sh pause                       # write $STATE/paused
sh ~/sapphire-agent/scripts/ctl.sh resume                      # remove $STATE/paused
sh ~/sapphire-agent/scripts/ctl.sh status                      # service state, paused?, projects, runs, commands, requests
sh ~/sapphire-agent/scripts/ctl.sh dispatch HL-14              # move the top-level epic to its ready state
sh ~/sapphire-agent/scripts/ctl.sh dispatch HL-14 --reply-to main  # the same; its run asks Claude session main its questions
sh ~/sapphire-agent/scripts/ctl.sh stop HL-12                  # end its run, interrupt its T3 thread
sh ~/sapphire-agent/scripts/ctl.sh send HL-9 Use the existing helper.
sh ~/sapphire-agent/scripts/ctl.sh follow-up HL-9 Rename it --threads PRRT_kwDO1 --threads PRRT_kwDO2
sh ~/sapphire-agent/scripts/ctl.sh session HL-9               # the Claude session name of its run, e.g. hl-9
sh ~/sapphire-agent/scripts/ctl.sh reply <comment-url> Done.   # as the bot on its issue or PR; only for a command's comment
sh ~/sapphire-agent/scripts/ctl.sh done CMD-3                  # the command agent is done
sh ~/sapphire-agent/scripts/ctl.sh project list                # the projects
sh ~/sapphire-agent/scripts/ctl.sh project add Unbound ~/unbound --label-repos ~/unbound-app
sh ~/sapphire-agent/scripts/ctl.sh project edit Unbound --repo ~/unbound
sh ~/sapphire-agent/scripts/ctl.sh project remove Telecord     # refused while a run of the team is in flight
sh ~/sapphire-agent/scripts/ctl.sh t3 status                   # T3 token accepted? expiry; each repo's T3 project, created if missing
sapphire hook claude < payload.json                           # what the Claude hooks run; any subcommand works as `sapphire`
```

- Pause stops new runs only: no ready epic and no follow-up is claimed. Claimed runs still start, runs in flight are still watched, results are still posted, worktrees still cleaned up, and mentions still run commands (so `resume` can come in as one).
- `pause`, `resume` and every recorded request write `$STATE/wake`, which makes the service tick at once; the log prints `dispatching paused` / `dispatching resumed`.
- Every subcommand but `hook` runs `node src/ctl.ts` (`status` prints the service state first), which reads `config.json`, the Linear key, the Linear webhook secret, the App's private key and webhook secret, the T3 token, and the journal, at the default paths unless `SAPPHIRE_AGENT_CONFIG_DIR` and `SAPPHIRE_AGENT_STATE_DIR` say otherwise (`config.md`). `stop`, `send`, `follow-up`, `reply`, `done` and `project add`, `edit` and `remove` only record a request the service acts on (`rules.md`); `project add` and `edit` first check the team in Linear, that the repo is a git repo with a GitHub `origin` and that the label repos directory exists; `dispatch` records a `start` request (with `--reply-to` the session its run asks, otherwise none), then moves the epic in Linear itself. `session` prints the run's session name, which `SendMessage` from any Claude session on the machine reaches. `dispatch` refuses a sub-issue (`<ID> is a sub-issue of <parent>; dispatch <parent> instead`), an unknown issue (`there is no issue <ID> in Linear`) and an epic whose team is not a project. A refusal (no such run, a `dispatch` for an epic whose run is not over, not a command's comment, a project that exists already or has a run in flight) goes to stderr with exit code 1.
- `status` prints `service: <systemd state>`, `dispatching: paused` or `active`, one line per project (team, repo, label repos directory, or `no projects`), one line per run (identifier, status, job, the epic's Linear state, claim time, T3 thread, session, the session it replies to if any, worktree, or `no runs`), then the commands queued or in flight (or `no commands`), then the requests waiting.
- `t3 status` pings T3 with the token from `t3.tokenFile` and prints `token: accepted, expires <ISO time>`, then per project `project <team>: <repo> is T3 project <id> (<title>)`, finding or creating the repo's T3 project as dispatch will (and remembering it in the journal), and for a label repos directory the T3 projects already in it. A rejected token is a refusal: `T3 rejects the token in <file>, which expires <time>; run scripts/mint-t3-token.sh again`.

## Drain

To get to a state with nothing in flight (before a risky deploy, or before stopping the service for a while):

1. `ctl.sh pause`.
2. Wait until `ctl.sh status` shows no run `claimed`, `running` or `stale`. Answer or start over flagged runs as needed (`rules.md`).
3. Do what you needed; `ctl.sh resume` afterwards.

`ended` and `kept` runs may stay: they hold no agent, only cleanup and follow-up bookkeeping. A command agent may still run after the pause (they are not paused); it is done within minutes or fails by itself.

## Cutover from herdr

The herdr version kept its config in `~/.config/herdr/plugins/config/sapphire-agent` and its state in `~/.local/state/herdr/plugins/sapphire-agent`, named by the unit's `HERDR_PLUGIN_*` variables; this version reads `~/.config/sapphire-agent` and `~/.local/state/sapphire-agent` (`config.md`). Its first start drops the herdr tab and pane of every run, so a run still in flight then has no T3 thread to watch, send to or stop.

1. Drain the herdr version (Drain above) and leave it paused.
2. Stop it, and move both directories to their new paths (the `paused` file moves with the state).
3. In `config.json`, point every secret file path at the new config directory, and delete `telegram`, `deliveryScanSeconds` and `workspaceLabel`: an unknown key stops startup.
4. Write the Pushover secret files and the T3 token (`scripts/mint-t3-token.sh`), and check T3's settings (above).
5. Unlink the herdr plugin (`herdr plugin unlink sapphire-agent`) and `systemctl --user disable --now herdr-server`, then `sh scripts/install.sh` and start the service (only when the user asks).
6. `sapphire resume`.

## Cutover from the old dispatcher

The old dispatcher kept its runs in `$STATE/claims.json`; the reconciler does not read it and there is no importer. On startup it refuses to run while that file still holds claims, with: `<path> still holds N claims of the old dispatcher. Drain it first: pause it (scripts/ctl.sh pause), wait until no run is in flight, then delete <path>.` The service then exits and systemd retries every 30 s, so nothing runs until the file is gone.

1. Pause the old dispatcher: `sh scripts/ctl.sh pause`.
2. Wait until nothing is in flight: `claims.json` holds no claim in `claimed`, `running`, `awaitingInput` or `stale` (the old `ctl.sh status` prints it).
3. Deploy: add `"allowedUsers": ["marioparaschiv"]` to `bot` in the config (`config.md`), update `~/sapphire-agent` to the new code and restart the service (only when the user asks). The first start imports config `teams` as projects; delete `teams` from the config afterwards.
4. Delete `$STATE/claims.json`. The next restart starts the reconciler.
5. `sh scripts/ctl.sh resume`.

After the cutover, epics the old dispatcher left in To Review have no journal row, so a follow-up cannot be asked for on their PRs; handle those threads by hand. Their worktrees are removed by the orphan worktree sweep once the epic is finished (Shipped or another completed or canceled state), unless they hold unsaved work.

## Logs and state

- Logs: `journalctl --user -u sapphire-agent -f` (stdout). Lines carry `epic=<IDENTIFIER>` and `rule=<name>` annotations. At startup: `imported the projects <names> from config.json's teams` once, and a warning while `teams` is still in the config.
- Logs of a command carry `task=CMD-<n>`, of the notices rule `task=notices` (`cannot post notice <key>; trying again next tick`, `there is no epic <ID> in Linear; dropping notice <key>`). Logs of a webhook delivery carry `delivery=<X-GitHub-Delivery>`: `queued the mention by @<login> in <url>`, `ignored the mention ...`, `refused a delivery ...`, `cannot handle the delivery`.
- State dir: `~/.local/state/sapphire-agent/` holds `journal.db`, `paused`, `wake` and `events.sock` (agent events, while the service runs).
- T3 threads: a run's in its repo's T3 project, titled `<IDENTIFIER> <title>` (`<IDENTIFIER> (2) <title>` and on after a handoff); a command's `CMD-<n>`, in a checkout under `$STATE/commands`.
- Worktrees: `~/.t3/worktrees/<repo>/<branch-slug>`, made by T3. Removed with the local branch once the epic is Shipped or its PR is merged or closed, unless they hold unpushed work (then a `keptWorktree` notice names the path).
- Handoff docs: `$TMPDIR/sapphire-agent-handoff-<IDENTIFIER>-<session or agent id>.md` (`/tmp` by default).

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Service crash-loops with `StartupError: cannot start, fix these and restart:` | Fix every listed problem (Linear key, Linear webhook secret, App key, webhook secret, Pushover file or T3 token missing, empty or not mode 600, invalid config field); see `config.md`. |
| Service crash-loops with `GitHub answered HTTP 401 to GET /app` | `bot.app.id` and the private key do not belong to the same App, or the key was revoked. Generate a new key (GitHub App above). |
| Service crash-loops with `... still holds N claims of the old dispatcher` | Finish the cutover (above). |
| Service crash-loops with a `ServeError` | Another process holds `bot.app.webhookPort` (`ss -ltnp 'sport = :3790'`). |
| `team X has no workflow state "..."; skipping it until it does` | Add the named states to that team in Linear (or change `states` in config). Picked up on the next tick, but the log line is printed only once per process and nothing is logged when it recovers. |
| `team X not found in Linear` | The project's team must be the team's exact name (`sapphire project list`; remove it and add it again under the right name). |
| Epic in Ready never picked up | Paused? Created less than `dispatchSettleSeconds` ago? Has `agent-stuck`? `maxInFlight` used up, maybe by a `stale` run or one whose agent is still working? Its team not a project (`sapphire project list`), or skipped? |
| A mention of the bot does nothing | `ctl.sh status`: is the command `queued` behind another? Is its author in `bot.allowedUsers` (an `ignored` command shows only in the journal)? Is `@<bot.login>` a whole word? Is the App installed on the repo? Its Recent Deliveries show each delivery's response: 401 means the webhook secret differs from `bot.app.webhookSecretFile`, 502 that nginx could not reach the service, 500 a journal error (`cannot handle the delivery` in the log). Redeliver a failed one by hand once fixed. |
| A follow-up was asked for but does not start | `ctl.sh status` shows the request waiting: paused? `maxInFlight` used up? Epic has `agent-stuck`, or is not in To Review? Its run must be `ended`; it waits while one is in flight. A request whose epic has no run is dropped. |
| A command failed | A `commandFailed` reply as the bot on its issue or PR says why. Mention the bot again. |
| A notice never shows up on its epic | Look for `cannot post notice` in the log (`rules.md`, Notices). |
| A Pushover notice `sapphire-agent cannot observe` | Linear or the journal has failed for `flagTransientAfterSeconds`; the log shows `observing failed` with the cause. Nothing is dispatched or watched until it works again. |
| A Pushover notice `T3 rejects the sapphire-agent token` | T3 answers 401: the token's session was revoked, or T3 changed its token format. Run `scripts/mint-t3-token.sh`, then check with `sapphire t3 status`. Nothing new is dispatched until then. |
| Epic has `agent-stuck` | Read its notice, a comment on the epic. Retry rules: `rules.md`. |
| PR is up but the epic stays in Implementing | The agent wrote no result file yet. A quiet thread is nudged after `staleAfterSeconds`, then flagged `stale`. |
| `failed; retrying next tick` repeating for an epic | A Transient failure (network, timeout, rate limit, git lock). It retries every tick without double-posting, and sends a notice once after `flagTransientAfterSeconds`. |
| A `handoffMissing` notice | The agent did not write the handoff doc after `/handoff`; no new thread takes over. Look at the agent in its T3 thread; `/handoff` again by hand, or let it go on. |

Retry quick reference:

- `startFailed`: fix the cause, remove `agent-stuck`.
- To start over (`error`, `stale`, `invalidResult`): move the epic to Ready and remove the label.

## Don't

- Don't edit `journal.db` by hand while the service runs. To forget a run, stop the service first; the next start observes everything again.
