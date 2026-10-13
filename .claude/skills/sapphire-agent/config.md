# Config

`config.json` in the config directory, read once at startup (restart the service after editing). Decoded with a strict `Schema` (`src/config.ts`): an unknown key fails startup (`Expected no excess property`).

## Directories and env vars

Read with Effect `Config`; none required, each defaulted in code (`config.ts`, `directories.ts`), so neither the unit nor `ctl.sh` sets them and a command thread's `ctl.sh` reaches the same journal and config. Empty counts as unset.

| Var | Default |
| --- | --- |
| `SAPPHIRE_AGENT_CONFIG_DIR` | `~/.config/sapphire-agent` |
| `SAPPHIRE_AGENT_STATE_DIR` (`$STATE`) | `~/.local/state/sapphire-agent`: `journal.db`, `paused`, `wake`, `events.sock`, `commands/` |
| `SAPPHIRE_AGENT_LINEAR_KEY_FILE` | `~/.config/sapphire-agent/linear-key` |
| `CLAUDE_CONFIG_DIR` | `~/.claude` (transcripts in its `projects`), as Claude Code reads it |

## Fields

| Field | Default | Notes |
| --- | --- | --- |
| `pollSeconds` | `600` | int ≥ 5. Backstop tick interval (`architecture.md`, Wakes). Timers are checked only on ticks, so may fire up to this late; an epic's Transient is retried only next tick. |
| `maxInFlight` | `1` | int ≥ 1. Counts `claimed`, `running`, `stale` runs, follow-ups included; not commands. |
| `dispatchSettleSeconds` | `60` | int ≥ 0. Minimum age (from `createdAt`) before claiming, since epics are often created before their sub-issues. |
| `awaitingInputAfterSeconds` | `180` | int ≥ 30. How long a command's thread may sit stopped without `done` before it fails. Old name `stuckAfterSeconds` still read. |
| `startTimeoutSeconds` | `300` | int ≥ 60. From claim (or process start, if later) to launch before the start fails; also the handoff doc deadline. |
| `staleAfterSeconds` | `600` | int ≥ 60. No progress this long: nudge. |
| `nudgeGraceSeconds` | `600` | int ≥ 60. Nothing from the agent this long after the nudge: `stale`, flagged. |
| `maxRunSeconds` | `5400` | int ≥ 600. Wall-clock cap from claim: flag once, run continues. Also the command cap. |
| `handoffAtTokens` | `250000` | int ≥ 10000. Context at which a run's agent or subagent hands off (`rules.md`, Handoff). |
| `flagTransientAfterSeconds` | `600` | int ≥ 60. Transient streak length before a `transientFailure` notice; also before the observing outage. |
| `worktreesDirectory` | `~/.t3/worktrees` | Must equal T3's own setting; run guards use it (`integrations.md`, Git). |
| `states.ready` / `implementing` / `inReview` / `toReview` / `shipped` | `Ready For Agent` / `Implementing` / `In Review` / `To Review` / `Shipped` | Exact state names; all five must exist in a team or it is skipped. |
| `labels.stuck` | `agent-stuck` | Added with every flag. |
| `labels.repoPrefix` | `repo:` | Repo label prefix; group name is it minus `:`. |
| `linearWebhookSecretFile` | required | Linear webhook signing secret. |
| `teams` | optional | Imported into projects once, at a start with none; warned at every start while present. Delete after import. |
| `bot.login` | required | Mention handle. |
| `bot.app.id` | required | int > 0, from the App's settings page. |
| `bot.app.privateKeyFile` | required | App private key (`.pem` as GitHub downloads it). |
| `bot.app.webhookSecretFile` | required | App webhook secret. |
| `bot.app.webhookPort` | `3790` | int 0–65535; `127.0.0.1:<port>`; 0 picks a free port (tests). |
| `bot.allowedUsers` | required | Non-empty array of GitHub logins (any case); others' mentions are `ignored`. |
| `pushover.appTokenFile` | `~/.config/sapphire-agent/pushover-app-token` | |
| `pushover.userKeyFile` | `~/.config/sapphire-agent/pushover-user-key` | |
| `t3.url` | `http://127.0.0.1:3773` | MCP at `<url>/mcp`. |
| `t3.tokenFile` | `~/.config/sapphire-agent/t3-token` | |
| `t3.settingsFile` | `~/.t3/userdata/settings.json` | Read at startup (`operations.md`, T3 settings) and at each launch for the default model. Missing: T3's defaults for the check, but every launch fails. |

All paths expand `~`.

## Secret files

Each holds plain text, whitespace trimmed, mode 600. Shared errors: group/other readable `... is readable by other users; run chmod 600 ...`; missing `no <name>: create <path> with mode 600`; empty fails.

| `<name>` | Path | Extra |
| --- | --- | --- |
| `Linear API key` | `SAPPHIRE_AGENT_LINEAR_KEY_FILE` | A Linear personal API key. |
| `GitHub App private key` | `bot.app.privateKeyFile`; live `app.pem` in the config dir | App settings, Private keys, Generate. Not PEM: `<path> is not a PEM private key`. A wrong App ID or key fails startup with `GitHub answered HTTP 401 to GET /app: ...`, outside the `StartupError`. |
| `GitHub App webhook secret` | `bot.app.webhookSecretFile`; live `webhook-secret` | App settings, Webhook secret. |
| `Linear webhook secret` | `linearWebhookSecretFile`; live `linear-webhook-secret` | Linear Settings, API, Webhooks, the webhook's page. |
| `Pushover app token`, `Pushover user key` | `pushover.*` | pushover.net, Create an Application; the dashboard's user key. Not 30 letters and digits: `<path> is not a Pushover app token: expected 30 letters and digits`. Service only (`PushoverConfig`). |
| `T3 token` | `t3.tokenFile` | A T3 session token (`<base64url JSON claims>.<signature>`) with runtime-mode ceiling full-access, so it may create projects and launch full-access threads. `scripts/mint-t3-token.sh` issues one with `t3 auth session issue` and re-signs its claims with `rtc: full-access` (T3 has no flag for it; no OAuth). Claims not decoding or without `exp` (epoch ms expiry): `<path> is not a T3 session token; run scripts/mint-t3-token.sh`. Service and CLI (`T3Config`). |

## Startup errors

Config and every secret file are checked before anything runs; all problems are logged together in one `StartupError` and the process exits non-zero. The CLI checks the same minus Pushover. A file whose path comes from an invalid config is not read.

```
StartupError: cannot start, fix these and restart:
- /home/dev/.config/sapphire-agent/config.json pollSeconds: Expected a value greater than or equal to 5
- /home/dev/.config/sapphire-agent/config.json maxInflight: Expected no excess property
- no Linear API key: create /home/dev/.config/sapphire-agent/linear-key with mode 600
```

## Projects

A project is a Linear team (exact name) the service watches, with the local clone its epics run in. Stored in the journal (`projects`), changed with `sapphire project` (`operations.md`, CLI); the CLI checks the team exists in Linear, the repo is a directory with a GitHub `origin`, and the label repos directory exists, then records a request applied next tick (`rules.md`, Requests).

- `repo`: default clone; GitHub `origin` required.
- `--label-repos` (`labelReposDirectory`): parent dir for repo-labelled epics; `repo:loader-ios` runs in `<dir>/loader-ios` (`integrations.md`, Repo labels).
- Paths accept `~`, stored absolute.

While the table is empty, startup imports config `teams` (`imported the projects <names> from config.json's teams`):

```json
"teams": {
	"Unbound": { "repo": "~/unbound", "labelReposDirectory": "~/unbound-app" },
	"Telecord": { "repo": "~/telecord" }
}
```

## Live config

`teams` Unbound (with `labelReposDirectory`), Telecord, Hivemind, and Sapphire Agent (`~/sapphire-agent`, so the service works on itself), to be deleted after import; `maxInFlight` 3; others default; `"linearWebhookSecretFile": "~/.config/sapphire-agent/linear-webhook-secret"`; Pushover files at their defaults; and:

```json
"bot": { "login": "orchestratorbot", "app": { "id": 123456, "privateKeyFile": "~/.config/sapphire-agent/app.pem", "webhookSecretFile": "~/.config/sapphire-agent/webhook-secret" }, "allowedUsers": ["marioparaschiv"] }
```

with the App's real ID (`operations.md`, GitHub App).
