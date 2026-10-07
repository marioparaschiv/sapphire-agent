# Config

Where configuration lives, every field with its default (`src/config.ts`), the projects (team-to-repo mapping), the API key, the Linear webhook secret, the GitHub App key and webhook secret files, the Telegram bot token, api_id and api_hash files, the env vars, and how startup reports problems.

## Files

| What | Path |
| --- | --- |
| Config | `$HERDR_PLUGIN_CONFIG_DIR/config.json` = `~/.config/herdr/plugins/config/sapphire-agent/config.json` |
| Linear API key | `~/.config/sapphire-agent/linear-key` (override `SAPPHIRE_AGENT_LINEAR_KEY_FILE`) |
| GitHub App private key | `bot.app.privateKeyFile`; live: `$HERDR_PLUGIN_CONFIG_DIR/app.pem` |
| GitHub App webhook secret | `bot.app.webhookSecretFile`; live: `$HERDR_PLUGIN_CONFIG_DIR/webhook-secret` |
| Linear webhook secret | `linearWebhookSecretFile`; live: `$HERDR_PLUGIN_CONFIG_DIR/linear-webhook-secret` |
| Telegram bot token, api_id, api_hash | `telegram.botTokenFile`, `telegram.apiIdFile`, `telegram.apiHashFile`; live: `$HERDR_PLUGIN_CONFIG_DIR/telegram-bot-token`, `telegram-api-id`, `telegram-api-hash` |
| Telegram session (mtcute) | `$HERDR_PLUGIN_STATE_DIR/telegram.session` |
| Claude config (trust) | `~/.claude.json` (override `CLAUDE_CONFIG_PATH`) |
| Claude session transcripts | `~/.claude/projects` (override the directory holding `projects` with `CLAUDE_CONFIG_DIR`) |
| Claude settings | `~/.claude/settings.json` (same override): the chat settings check and `promptCacheTtl` (`architecture.md`, The chat) |
| Projects | The journal's `projects` table, managed with `sapphire project` (below) |
| Journal | `$HERDR_PLUGIN_STATE_DIR/journal.db` |
| Pause file | `$HERDR_PLUGIN_STATE_DIR/paused` |

Config is read once at startup. Restart the service after editing (see `operations.md`).

## Fields

Decoded with an Effect `Schema`. The schema is strict: an unknown key fails startup naming the field (`Expected no excess property`).

| Field | Default | Notes |
| --- | --- | --- |
| `pollSeconds` | `600` | int, min 5. The backstop poll: the tick interval when nothing else wakes the reconciler. Linear webhook deliveries, herdr events and `ctl.sh` requests trigger extra ticks in between. Monitoring timers (`awaitingInputAfterSeconds`, `staleAfterSeconds` and the others) are checked only on ticks, so they can fire up to this long late, and an epic's transient failure is retried only on the next tick. |
| `maxInFlight` | `1` | int, min 1. Counts `claimed`, `running`, `awaitingInput`, `stale` runs, follow-ups included. Command runs do not count (`rules.md`). |
| `dispatchSettleSeconds` | `60` | int, min 0. How old a ready epic must be (from its `createdAt`) before it is claimed, since an epic is often created before its sub-issues. |
| `awaitingInputAfterSeconds` | `180` | int, min 30. Quiet (`idle`, `done`, `blocked`) time without a result file before the pane tail is asked in the epic's topic, or the epic is flagged `awaitingInput` when it has none. The old name `stuckAfterSeconds` is still read as this key. |
| `startTimeoutSeconds` | `300` | int, min 60. Time from the claim (or the process start, if later) for Claude to be confirmed started before the start fails. Covers waiting behind other starts, the fetch and herdr's 30 s start wait. |
| `staleAfterSeconds` | `600` | int, min 60. herdr says `working` but the pane output has not changed for this long: nudge once. Also how long a run waits quietly for a reply to its message before its question is asked in its epic's topic. |
| `nudgeGraceSeconds` | `600` | int, min 60. Output still unchanged this long after the nudge: run `stale`, epic flagged. |
| `maxRunSeconds` | `5400` | int, min 600. Wall-clock cap from the claim; the epic is flagged once, in any in-flight state. The run keeps going. |
| `handoffAtTokens` | `250000` | int, min 10000. Context (input, cache read and cache creation tokens of the latest assistant entry) at which a run's agent, or one of its subagents, hands its work to a fresh session (`rules.md`, Handoff). |
| `managerRotateAtTokens` | `50000` | int, min 10000. Context (input, cache read and cache creation tokens of the latest main-thread assistant message, checked when a turn ends) at which the main chat's manager is replaced by a fresh session that starts from its summary (`architecture.md`, the manager). |
| `flagTransientAfterSeconds` | `600` | int, min 60. How long an epic's work may keep failing with Transient errors before a `transientFailure` notice is sent once (see `failure-policy.md`). |
| `deliveryScanSeconds` | `300` | int, min 60. How often the App's failed webhook deliveries are looked for and redelivered, besides once at startup (`rules.md`, Missed deliveries). |
| `worktreesDirectory` | `~/.herdr/worktrees` | `~` expanded. |
| `workspaceLabel` | `agents` | herdr workspace for command tabs whose repo belongs to no project. Run tabs go in a workspace named after their project's team. |
| `states.*` | see below | Exact Linear workflow state names. |
| `labels.stuck` | `agent-stuck` | Label added with every flag. |
| `labels.repoPrefix` | `repo:` | Repo label prefix; the label group name is this without the trailing `:`. |
| `linearWebhookSecretFile` | required | `~` expanded. The signing secret of the Linear webhook, see below. |
| `teams` | optional | Imported into the journal's projects once, at a start when it has none; a warning is logged at every start while the key stays. Delete it after the import and use `sapphire project` (below). |
| `bot.login` | required | The mention handle. A comment mentioning `@<login>` starts a command run (`rules.md`). |
| `bot.app.id` | required | int, above 0. The GitHub App's ID, from its settings page. The App makes every GitHub write: thread replies and resolves, `Addressed your concerns inline.`, thumbs-ups on mentions. |
| `bot.app.privateKeyFile` | required | `~` expanded. The App's private key (`.pem`, as GitHub downloads it), see below. |
| `bot.app.webhookSecretFile` | required | `~` expanded. The App's webhook secret, see below. |
| `bot.app.webhookPort` | `3790` | int, 0 to 65535. The webhook server listens on `127.0.0.1:<port>`; nginx forwards `https://webhook.marioparaschiv.com/github` to it, and Tailscale Funnel forwards `/linear` (`operations.md`). 0 picks a free port (tests). |
| `bot.allowedUsers` | required | Non-empty array of GitHub logins (any case). Only their mentions of the bot start a command; anyone else's is recorded as ignored and does nothing. |
| `telegram.botTokenFile` | required | `~` expanded. The Telegram bot's token, see below. |
| `telegram.apiIdFile`, `telegram.apiHashFile` | required | `~` expanded. The `api_id` and `api_hash` of a Telegram app (my.telegram.org), which the bot logs in over MTProto with, see below. |
| `telegram.allowedUserIds` | required | Non-empty array of numeric Telegram user ids. Only their messages in their private chat with the bot reach the service; anyone else's are dropped and logged (`architecture.md`, The chat). Epic and project topics and notices go to the private chat of the first id. |
| `telegram.transcriptionModelDirectory` | `$HERDR_PLUGIN_STATE_DIR/models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8` | `~` expanded. The sherpa-onnx Parakeet TDT 0.6B v3 int8 model voice notes are transcribed with: `encoder.int8.onnx`, `decoder.int8.onnx`, `joiner.int8.onnx` and `tokens.txt`. Transcription also needs `ffmpeg` on `PATH`. |

`states` defaults: `ready` "Ready For Agent", `implementing` "Implementing", `inReview` "In Review", `toReview` "To Review", `shipped` "Shipped". All five must exist in a team or it is skipped.

## Projects

A project is a Linear team sapphire-agent watches, by its exact name, and the local clone its epics run in. Projects live in the journal (`projects`), not the config; the CLI checks each change (the team exists in Linear, the repo is a directory with a GitHub `origin`, the label repos directory exists) and records a request the service applies on its next tick (`rules.md`, Requests):

```sh
sapphire project list
sapphire project add Unbound ~/unbound --label-repos ~/unbound-app
sapphire project edit Unbound --repo ~/unbound
sapphire project remove Telecord   # refused while a run of the team is in flight; deletes its topic
```

- `repo`: local clone used by default. Must have a GitHub `origin`.
- `--label-repos` (`labelReposDirectory`): parent dir for repo-labelled epics. `repo:loader-ios` runs in `<dir>/loader-ios`.
- Paths accept `~` and are stored absolute. Repo label rules: `linear-api.md`.

While the table is empty, the service imports config `teams` at startup (`imported the projects <names> from config.json's teams`), keyed by exact Linear team name:

```json
"teams": {
	"Unbound": { "repo": "~/unbound", "labelReposDirectory": "~/unbound-app" },
	"Telecord": { "repo": "~/telecord" }
}
```

Live config today: `teams` Unbound (with `labelReposDirectory`), Telecord, Hivemind, and Sapphire Agent (this repo, `~/sapphire-agent`, so the plugin works on itself), imported as projects on the first start that has none, then to be deleted; `maxInFlight` 3, all other fields at their defaults. It needs `"linearWebhookSecretFile": "~/.config/herdr/plugins/config/sapphire-agent/linear-webhook-secret"` and this `bot` entry before this version starts:

```json
"bot": {
	"login": "orchestratorbot",
	"app": {
		"id": 123456,
		"privateKeyFile": "~/.config/herdr/plugins/config/sapphire-agent/app.pem",
		"webhookSecretFile": "~/.config/herdr/plugins/config/sapphire-agent/webhook-secret"
	},
	"allowedUsers": ["marioparaschiv"]
}
```

with the App's real ID (`operations.md` covers creating and installing the App).

It also needs a `telegram` entry, with the bot's files and the user's numeric Telegram id:

```json
"telegram": {
	"botTokenFile": "~/.config/herdr/plugins/config/sapphire-agent/telegram-bot-token",
	"apiIdFile": "~/.config/herdr/plugins/config/sapphire-agent/telegram-api-id",
	"apiHashFile": "~/.config/herdr/plugins/config/sapphire-agent/telegram-api-hash",
	"allowedUserIds": [123456789]
}
```

## API key

- Plain text file containing a Linear personal API key; whitespace trimmed.
- Must not be readable by group or others, so use `chmod 600`. Otherwise startup fails with `... is readable by other users; run chmod 600 ...`.
- Missing file: `no Linear API key: create <path> with mode 600`. An empty file also fails.

## GitHub App private key

- The PEM private key GitHub generates for the App (App settings, Private keys, Generate). Read and parsed at startup.
- Same rules as the API key: mode 600, else `... is readable by other users; run chmod 600 ...`; missing: `no GitHub App private key: create <path> with mode 600`; empty fails; a file that is no PEM private key fails with `<path> is not a PEM private key`.
- At startup the service also signs a JWT with it and reads the App (`GET /app`) for its slug. A wrong App ID or key fails startup with `GitHub answered HTTP 401 to GET /app: ...`, outside the `StartupError`.

## GitHub App webhook secret

- The secret set in the App's settings (Webhook secret), as plain text; whitespace trimmed. Every delivery's `X-Hub-Signature-256` is checked against it.
- Same rules as the API key: mode 600, else `... is readable by other users; run chmod 600 ...`; missing: `no GitHub App webhook secret: create <path> with mode 600`; empty fails.

## Linear webhook secret

- The signing secret Linear shows on the webhook's page (Settings, API, Webhooks), as plain text; whitespace trimmed. Every Linear delivery's `Linear-Signature` is checked against it.
- Same rules as the API key: mode 600, else `... is readable by other users; run chmod 600 ...`; missing: `no Linear webhook secret: create <path> with mode 600`; empty fails.

## Telegram bot token, api_id and api_hash

- The token BotFather gives the bot (`123456:ABC...`), as plain text; whitespace trimmed.
- `api_id` (a number) and `api_hash` come from the Telegram app registered at my.telegram.org, each as plain text in its own file.
- Same rules as the API key for all three: mode 600, else `... is readable by other users; run chmod 600 ...`; missing: `no Telegram bot token: create <path> with mode 600` (or `api_id`, `api_hash`); empty fails; an `api_id` that is no number fails with `<path> is not a number`.
- The bot logs in at startup; a refused login stops startup with `Telegram refused to log in as the bot: ...`, outside the `StartupError`.

## Env vars

Read with Effect `Config`; set by `systemd/sapphire-agent.service`. `scripts/ctl.sh` defaults the four required ones to the same values, and a command's tab gets the service's own values (`rules.md`).

| Var | Required | Value in the unit |
| --- | --- | --- |
| `HERDR_BIN_PATH` | yes | `%h/.local/bin/herdr` |
| `HERDR_SOCKET_PATH` | yes | `%h/.config/herdr/herdr.sock` (default session) |
| `HERDR_PLUGIN_CONFIG_DIR` | yes | `%h/.config/herdr/plugins/config/sapphire-agent` |
| `HERDR_PLUGIN_STATE_DIR` | yes | `%h/.local/state/herdr/plugins/sapphire-agent` |
| `SAPPHIRE_AGENT_LINEAR_KEY_FILE` | no | default `~/.config/sapphire-agent/linear-key` |
| `CLAUDE_CONFIG_PATH` | no | default `~/.claude.json` |
| `CLAUDE_CONFIG_DIR` | no | default `~/.claude`, as Claude Code reads it |

## Startup errors

Env, the config file, the API key, the Linear webhook secret, the App's private key and webhook secret and the Telegram bot token, `api_id` and `api_hash` are all checked, and the transcription model's files looked for, before anything runs, and every problem is reported together in one `StartupError`, logged once, after which the process exits non-zero. The CLI (`ctl.ts`) checks the same minus the Telegram files and the model, which only the service uses. The chat settings check and `promptCacheTtl` are read after startup and only warn (`architecture.md`, The chat):

```
StartupError: cannot start, fix these and restart:
- HERDR_BIN_PATH: Expected string
- /home/dev/.config/herdr/plugins/config/sapphire-agent/config.json pollSeconds: Expected a value greater than or equal to 5
- /home/dev/.config/herdr/plugins/config/sapphire-agent/config.json maxInflight: Expected no excess property
- no Linear API key: create /home/dev/.config/sapphire-agent/linear-key with mode 600
- /home/dev/.config/herdr/plugins/config/sapphire-agent/app.pem is readable by other users; run chmod 600 /home/dev/.config/herdr/plugins/config/sapphire-agent/app.pem
- no transcription model in /home/dev/.local/state/herdr/plugins/sapphire-agent/models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8: encoder.int8.onnx, tokens.txt missing; download sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8 there
```

A file whose path comes from a missing env var or an invalid config file is not read; that problem is already reported. Startup also stops while the old dispatcher's `claims.json` still holds claims (`operations.md`).
