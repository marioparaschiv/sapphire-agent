# Config

Where configuration lives, every field with its default (`src/config.ts`), the team-to-repo mapping, the API key and the GitHub App key and webhook secret files, the env vars, and how startup reports problems.

## Files

| What | Path |
| --- | --- |
| Config | `$HERDR_PLUGIN_CONFIG_DIR/config.json` = `~/.config/herdr/plugins/config/herdr-linear/config.json` |
| Linear API key | `~/.config/herdr-linear/linear-key` (override `HERDR_LINEAR_KEY_FILE`) |
| GitHub App private key | `bot.app.privateKeyFile`; live: `$HERDR_PLUGIN_CONFIG_DIR/app.pem` |
| GitHub App webhook secret | `bot.app.webhookSecretFile`; live: `$HERDR_PLUGIN_CONFIG_DIR/webhook-secret` |
| Claude config (trust) | `~/.claude.json` (override `CLAUDE_CONFIG_PATH`) |
| Journal | `$HERDR_PLUGIN_STATE_DIR/journal.db` |
| Pause file | `$HERDR_PLUGIN_STATE_DIR/paused` |

Config is read once at startup. Restart the service after editing (see `operations.md`).

## Fields

Decoded with an Effect `Schema`. The schema is strict: an unknown key fails startup naming the field (`Expected no excess property`).

| Field | Default | Notes |
| --- | --- | --- |
| `pollSeconds` | `30` | int, min 5. Tick interval; herdr events trigger extra ticks in between. |
| `maxInFlight` | `1` | int, min 1. Counts `claimed`, `running`, `awaitingInput`, `stale` runs, follow-ups included. Command runs do not count (`rules.md`). |
| `awaitingInputAfterSeconds` | `180` | int, min 30. Quiet (`idle`, `done`, `blocked`) time without a result file before the epic is flagged `awaitingInput`. The old name `stuckAfterSeconds` is still read as this key. |
| `startTimeoutSeconds` | `300` | int, min 60. Time from the claim (or the process start, if later) for Claude to be confirmed started before the start fails. Covers waiting behind other starts, the fetch and herdr's 30 s start wait. |
| `staleAfterSeconds` | `600` | int, min 60. herdr says `working` but the pane output has not changed for this long: nudge once. |
| `nudgeGraceSeconds` | `600` | int, min 60. Output still unchanged this long after the nudge: run `stale`, epic flagged. |
| `maxRunSeconds` | `5400` | int, min 600. Wall-clock cap from the claim; the epic is flagged once, in any in-flight state. The run keeps going. |
| `flagTransientAfterSeconds` | `600` | int, min 60. How long an epic's work may keep failing with Transient errors before a `transientFailure` comment is posted once (see `failure-policy.md`). |
| `deliveryScanSeconds` | `300` | int, min 60. How often the App's failed webhook deliveries are looked for and redelivered, besides once at startup (`rules.md`, Missed deliveries). |
| `worktreesDirectory` | `~/.herdr/worktrees` | `~` expanded. |
| `workspaceLabel` | `agents` | herdr workspace that holds the run tabs. |
| `states.*` | see below | Exact Linear workflow state names. |
| `labels.stuck` | `agent-stuck` | Label added with every flag. |
| `labels.repoPrefix` | `repo:` | Repo label prefix; the label group name is this without the trailing `:`. |
| `teams` | required | At least one team. |
| `bot.login` | required | The mention handle. A comment mentioning `@<login>` starts a command run (`rules.md`). |
| `bot.app.id` | required | int, above 0. The GitHub App's ID, from its settings page. The App posts every comment of the bot: command replies and failure notices. |
| `bot.app.privateKeyFile` | required | `~` expanded. The App's private key (`.pem`, as GitHub downloads it), see below. |
| `bot.app.webhookSecretFile` | required | `~` expanded. The App's webhook secret, see below. |
| `bot.app.webhookPort` | `3790` | int, 0 to 65535. The webhook server listens on `127.0.0.1:<port>`; nginx forwards `https://herdr.marioparaschiv.com/github` to it (`operations.md`). 0 picks a free port (tests). |
| `bot.allowedUsers` | required | Non-empty array of GitHub logins (any case). Only their mentions of the bot start a command; anyone else's is recorded as ignored and does nothing. |

`states` defaults: `ready` "Ready For Agent", `implementing` "Implementing", `inReview` "In Review", `toReview` "To Review", `shipped` "Shipped". All five must exist in a team or it is skipped.

## Teams

Keyed by exact Linear team name:

```json
"teams": {
	"Unbound": { "repo": "~/unbound", "labelReposDirectory": "~/unbound-app" },
	"Telecord": { "repo": "~/telecord" }
}
```

- `repo`: local clone used by default. Must have a GitHub `origin`.
- `labelReposDirectory` (optional): parent dir for repo-labelled epics. `repo:loader-ios` runs in `~/unbound-app/loader-ios`.
- Paths accept `~`. Repo label rules: `linear-api.md`.

Live config today: teams Unbound (with `labelReposDirectory`), Telecord, Hivemind, and Herdr Linear (this repo, `~/herdr-linear`, so the plugin works on itself); `maxInFlight` 3, all other fields at their defaults. It needs this `bot` entry before this version starts:

```json
"bot": {
	"login": "orchestratorbot",
	"app": {
		"id": 123456,
		"privateKeyFile": "~/.config/herdr/plugins/config/herdr-linear/app.pem",
		"webhookSecretFile": "~/.config/herdr/plugins/config/herdr-linear/webhook-secret"
	},
	"allowedUsers": ["marioparaschiv"]
}
```

with the App's real ID (`operations.md` covers creating and installing the App).

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

## Env vars

Read with Effect `Config`; set by `systemd/herdr-linear.service`. `scripts/ctl.sh` defaults the four required ones to the same values, and a command's tab gets the service's own values (`rules.md`).

| Var | Required | Value in the unit |
| --- | --- | --- |
| `HERDR_BIN_PATH` | yes | `%h/.local/bin/herdr` |
| `HERDR_SOCKET_PATH` | yes | `%h/.config/herdr/herdr.sock` (default session) |
| `HERDR_PLUGIN_CONFIG_DIR` | yes | `%h/.config/herdr/plugins/config/herdr-linear` |
| `HERDR_PLUGIN_STATE_DIR` | yes | `%h/.local/state/herdr/plugins/herdr-linear` |
| `HERDR_LINEAR_KEY_FILE` | no | default `~/.config/herdr-linear/linear-key` |
| `CLAUDE_CONFIG_PATH` | no | default `~/.claude.json` |

## Startup errors

Env, the config file, the API key and the App's private key and webhook secret are all checked before anything runs, and every problem is reported together in one `StartupError`, logged once, after which the process exits non-zero:

```
StartupError: cannot start, fix these and restart:
- HERDR_BIN_PATH: Expected string
- /home/dev/.config/herdr/plugins/config/herdr-linear/config.json pollSeconds: Expected a value greater than or equal to 5
- /home/dev/.config/herdr/plugins/config/herdr-linear/config.json maxInflight: Expected no excess property
- no Linear API key: create /home/dev/.config/herdr-linear/linear-key with mode 600
- /home/dev/.config/herdr/plugins/config/herdr-linear/app.pem is readable by other users; run chmod 600 /home/dev/.config/herdr/plugins/config/herdr-linear/app.pem
```

A file whose path comes from a missing env var or an invalid config file is not read; that problem is already reported. Startup also stops while the old dispatcher's `claims.json` still holds claims (`operations.md`).
