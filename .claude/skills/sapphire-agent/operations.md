# Operations

## The unit

`~/.config/systemd/user/sapphire-agent.service`, from `systemd/sapphire-agent.service`: runs `node src/main.ts` in `~/sapphire-agent`, `Restart=always`, `RestartSec=30`.

- `ExecStart` pins `~/.nvm/versions/node/v24.21.0/bin/node`; update it after a Node upgrade.
- `PATH` is `~/.local/bin:/usr/local/bin:/usr/bin:/bin` (the only env it sets); `git` and `gh` must be there, `gh` logged in as the user (reads only).
- Apply config or code changes with `systemctl --user restart sapphire-agent` (only when the user asks); nothing is lost (the next tick observes again, the journal carries the rest).
- Edits in `systemd/` do nothing until `sh scripts/install.sh` (or a copy and `daemon-reload`).
- Needs the Pushover files (`config.md`). Listens on `127.0.0.1:<bot.app.webhookPort>` (default 3790).
- A command agent runs `node` via `ctl.sh` in its T3 thread, so `node` 24 must be on the `PATH` T3 gives agents.

## Install

`sh scripts/install.sh` (idempotent): symlinks `~/.local/bin/sapphire` to `scripts/ctl.sh`, copies the unit, `systemctl --user daemon-reload` and `enable`.

Claude hooks are added by hand to `~/.claude/settings.json`: `{ "type": "command", "command": "sapphire hook claude", "async": true, "timeout": 10 }` under each of `SessionStart`, `UserPromptSubmit`, `Stop`, `Notification`, `SessionEnd`; and two that are not `async`, so Claude waits for the answer:

```json
"PostToolUse": [
  { "hooks": [{ "type": "command", "command": "sapphire hook claude", "timeout": 10 }] }
],
"PreToolUse": [
  { "matcher": "Bash|Write|Edit|MultiEdit|NotebookEdit", "hooks": [{ "type": "command", "command": "sapphire hook claude", "timeout": 10 }] }
]
```

Pi loads the extension from the checkout: add `"~/sapphire-agent/src/pi-extension.ts"` to `extensions` in `~/.pi/agent/settings.json` (Pi resolves its Effect from the repo's `node_modules`). Install it only once the running service knows Pi events (`pi` in `adapters`); an older one refuses each and the extension warns on every event. It loads in about 300 ms per Pi session.

`PostToolUse` (every tool) delivers a subagent's handoff instruction; widen it only once the running service knows every tool, since an older one refuses all but `Skill` and the hook fails on each. `PreToolUse` carries the run guards and the command threads' read-only guard (`rules.md`); its matcher spares other tools the hook, and widening it would refuse command threads' tools other than `Read`, `Grep`, `Glob`, `SendMessage`, at about 350 ms per call in every session.

## T3 settings

No MCP tool reads or changes them; set once by hand (stored in `~/.t3/userdata/settings.json`):

- Each dispatched-to project (every `sapphire project` repo and label repo): **Automatic worktree cleanup** **Off**, since T3's `storageCleanup` (e.g. "no commits beyond the default branch") could remove a run's worktree.
- **Settings → General**, **Auto-settle merged threads**: on (default).
- A **default model** (`defaultModelSelection`). Without it every start fails Permanently with `set a default model in T3`.
- **Settings → Notifications**, **Device Notifications** on, T3 Connect linked: T3 pushes runs finishing, failing or waiting for input; Pushover carries only the service's own notices.

At startup the service checks this file and sends one Pushover notice `T3's settings need a change for sapphire-agent` naming each project to fix; a repo T3 has no project for yet is checked against the environment settings it will inherit. `$STATE/commands` is not T3-managed.

## GitHub App

Created and installed by hand:

1. GitHub Settings, Developer settings, GitHub Apps. Permissions: Issues RW, Pull requests RW, Contents R, Metadata R. Events: Issue comment, Pull request review, Pull request review comment. Webhook URL `https://webhook.marioparaschiv.com/github`, with a secret.
2. Save the secret as `webhook-secret` and a generated private key as `app.pem` in the config directory, `chmod 600`; put the App ID and paths in `bot.app`.
3. Install it on every repo the bot answers on. Only installed repos deliver; a write elsewhere fails with `GitHub answered HTTP 404 to GET /repos/<owner>/<name>/installation: Not Found`.

nginx terminates TLS for `https://webhook.marioparaschiv.com` (the `*.marioparaschiv.com` Cloudflare origin certificate) and forwards only `/github` to `127.0.0.1:3790`; other paths 404. Site config, DNS record and nginx reload need sudo. Response codes: `rules.md`, Webhook deliveries. GitHub does not redeliver failures (500, or 502 from nginx while the service is down): use the App's Advanced, Recent Deliveries; redelivering a success starts nothing.

## Linear webhook

Linear pushes only via webhooks to a public HTTPS URL. Set up once:

1. `sudo tailscale funnel --bg --set-path /linear http://127.0.0.1:3790/linear` (prints a link if Funnel or HTTPS certificates are off). `tailscale funnel status` shows `https://<machine>.<tailnet>.ts.net/linear`.
2. Linear Settings, API, Webhooks: label `sapphire-agent`, that URL, data change events Issues and Comments, all public teams.
3. Save its signing secret as `linear-webhook-secret` in the config directory, `chmod 600`, set `linearWebhookSecretFile`.
4. `systemctl --user restart sapphire-agent` (when the user asks).

Deliveries while down are not replayed; the startup tick and the poll catch up.

## CLI

`sapphire <action>` = `sapphire ctl <action>` = `sh ~/sapphire-agent/scripts/ctl.sh <action>`. No env needed, works from any shell including T3 threads. The `/dispatch` skill (`~/.claude/skills/dispatch`) wraps `dispatch`, `status`, `stop`, `pause`, `resume`.

```sh
sapphire pause | resume                    # write / remove $STATE/paused (rules.md, Order)
sapphire status
sapphire dispatch HL-14 [--reply-to main]  # move the top-level epic to its ready state; its run asks session main its questions
sapphire stop HL-12                        # end its run, interrupt its thread
sapphire send HL-9 Use the existing helper.
sapphire follow-up HL-9 Rename it --threads PRRT_kwDO1 --threads PRRT_kwDO2
sapphire session HL-9                      # its run's session name (e.g. hl-9), reachable by SendMessage from any Claude session
sapphire reply <comment-url> Done.         # as the bot; only a command's comment
sapphire done CMD-3
sapphire project list
sapphire project add Unbound ~/unbound --label-repos ~/unbound-app
sapphire project edit Unbound --repo ~/unbound
sapphire project remove Telecord           # refused while a run of the team is in flight
sapphire t3 status
sapphire hook claude < payload.json        # what the Claude hooks run
```

- All but `hook` run `node src/ctl.ts`, which reads config, secrets (not Pushover) and the journal, and only appends requests, so never races a rule.
- `stop`, `send`, `follow-up`, `reply`, `done`, `project add|edit|remove` only record a request (`rules.md`). `dispatch` records a `start` request (with `--reply-to` or none), then moves the epic in Linear itself (idempotent).
- Every request, `pause` and `resume` touches `$STATE/wake`; the log prints `dispatching paused` / `dispatching resumed`.
- `dispatch` refuses a sub-issue (`<ID> is a sub-issue of <parent>; dispatch <parent> instead`), an unknown issue (`there is no issue <ID> in Linear`), a team that is not a project, and an epic whose run is not over. Refusals (also: no such run, not a command's comment, a project that exists or has a run in flight) go to stderr, exit 1.
- `status`: `service: <systemd state>`, `dispatching: paused|active`, a line per project (team, repo, label repos directory; or `no projects`), per run (identifier, status, job, Linear state, claim time, T3 thread, session, reply-to if any, worktree; or `no runs`), per held epic (`<ID> held by <ID>, <ID>`), commands queued or in flight (or `no commands`), waiting requests.
- `t3 status`: pings T3 with the token, prints `token: accepted, expires <ISO time>`, then per project `project <team>: <repo> is T3 project <id> (<title>)`, finding or creating it as dispatch will (remembered in the journal), and for a label repos directory the T3 projects already in it. Rejected: `T3 rejects the token in <file>, which expires <time>; run scripts/mint-t3-token.sh again`, exit 1.

## Drain

1. `sapphire pause`.
2. Wait until `sapphire status` shows no `claimed`, `running` or `stale` run; answer or start over flagged runs (`rules.md`, Retrying).
3. Do the work; `sapphire resume`.

`ended` and `kept` runs may stay (no agent). A command agent may still run; it finishes or fails within minutes.

## Cutover from herdr

The herdr version used `~/.config/herdr/plugins/config/sapphire-agent` and `~/.local/state/herdr/plugins/sapphire-agent` (the unit's `HERDR_PLUGIN_*` vars). Its first start here drops every run's herdr tab and pane, so a run in flight then has no T3 thread to watch, send to or stop.

1. Drain the herdr version and leave it paused.
2. Stop it; move both directories to the new paths (`paused` moves with the state).
3. In `config.json`, point secret paths at the new config dir; delete `telegram`, `deliveryScanSeconds`, `workspaceLabel`.
4. Write the Pushover files and the T3 token (`scripts/mint-t3-token.sh`); check T3 settings.
5. `herdr plugin unlink sapphire-agent`, `systemctl --user disable --now herdr-server`, `sh scripts/install.sh`, start the service (when the user asks).
6. `sapphire resume`.

## Cutover from the old dispatcher

It kept runs in `$STATE/claims.json`; there is no importer. Startup refuses while it holds claims: `<path> still holds N claims of the old dispatcher. Drain it first: pause it (scripts/ctl.sh pause), wait until no run is in flight, then delete <path>.`; systemd retries every 30 s.

1. `sh scripts/ctl.sh pause`.
2. Wait until `claims.json` has no claim `claimed`, `running`, `awaitingInput` or `stale` (old `ctl.sh status`).
3. Add `"allowedUsers": ["marioparaschiv"]` to `bot`, update `~/sapphire-agent`, restart (when the user asks). The first start imports `teams`; delete it afterwards.
4. Delete `$STATE/claims.json`; the next restart starts the reconciler.
5. `sh scripts/ctl.sh resume`.

Epics it left in To Review have no run, so no follow-up can be asked for: handle those threads by hand. Their worktrees go via the orphan sweep once finished, unless unsaved.

## Logs and state

- `journalctl --user -u sapphire-agent -f`. Annotations: `epic=<ID>`, `rule=<name>`, `task=CMD-<n>`, `task=notices` (`cannot post notice <key>; trying again next tick`, `there is no epic <ID> in Linear; dropping notice <key>`), GitHub `delivery=<X-GitHub-Delivery>` (`queued the mention by @<login> in <url>`, `ignored the mention ...`, `refused a delivery ...`, `cannot handle the delivery`), Linear `delivery=<Linear-Delivery>`.
- Don't edit `journal.db` while the service runs. To forget a run, stop the service first; the next start observes everything again.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Crash loop, `StartupError: cannot start, fix these and restart:` | Fix every listed item (`config.md`). |
| Crash loop, `GitHub answered HTTP 401 to GET /app` | App ID and key do not match, or key revoked; generate a new key. |
| Crash loop, `... still holds N claims of the old dispatcher` | Finish that cutover. |
| Crash loop, `ServeError` | Port taken: `ss -ltnp 'sport = :3790'`. |
| `team X has no workflow state "..."; skipping it until it does` | Add the state in Linear or change `states`. Picked up next tick; logged once per process, nothing logged on recovery. |
| `team X not found in Linear` | Project's team must be the exact name; remove and re-add. |
| Ready epic never picked up, follow-up not starting | `sapphire status`, then the conditions in `rules.md` (Dispatch, Follow-up). |
| Mention does nothing | `sapphire status`: `queued` behind another? Author not in `bot.allowedUsers` (`ignored` shows only in the journal)? `@<bot.login>` not a whole word? App not installed? Recent Deliveries: 401 secret mismatch, 502 nginx cannot reach the service, 500 journal error (`cannot handle the delivery`). Redeliver once fixed. |
| Notice missing on the epic | `cannot post notice` in the log. |
| Pushover `T3 rejects the sapphire-agent token` | Session revoked or token format changed: `scripts/mint-t3-token.sh`, then `sapphire t3 status`. |
| `agent-stuck`, failed command | Read its notice or `commandFailed` reply; `rules.md`, Retrying. |
| PR up, epic stays Implementing | No result file yet (`rules.md`, Monitoring). |
| `handoffMissing` | No doc after `/handoff` (Pi: the handoff skill's file): look at the thread, ask again by hand, or let it go on. |
| Pi run never records its session | The extension could not ask T3 its thread (no `T3_MCP_URL`, T3 down): its events are dropped and the next one asks again. Not loaded: `pi config` lists extensions. |
