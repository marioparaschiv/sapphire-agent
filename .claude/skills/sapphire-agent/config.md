# Config

Where configuration lives, every field with its default (`src/config.ts`), the projects (team-to-repo mapping), the API key, the Linear webhook secret, the GitHub App key and webhook secret files, the Pushover app token and user key files, the T3 token, the env vars, and how startup reports problems.

## Files

| What | Path |
| --- | --- |
| Config directory | `~/.config/sapphire-agent` (override `SAPPHIRE_AGENT_CONFIG_DIR`) |
| State directory | `~/.local/state/sapphire-agent` (override `SAPPHIRE_AGENT_STATE_DIR`) |
| Config | `config.json` in the config directory |
| Linear API key | `~/.config/sapphire-agent/linear-key` (override `SAPPHIRE_AGENT_LINEAR_KEY_FILE`) |
| GitHub App private key | `bot.app.privateKeyFile`; live: `app.pem` in the config directory |
| GitHub App webhook secret | `bot.app.webhookSecretFile`; live: `webhook-secret` in the config directory |
| Linear webhook secret | `linearWebhookSecretFile`; live: `linear-webhook-secret` in the config directory |
| Pushover app token, user key | `pushover.appTokenFile`, `pushover.userKeyFile`; default `~/.config/sapphire-agent/pushover-app-token`, `~/.config/sapphire-agent/pushover-user-key` |
| T3 token | `t3.tokenFile`; default `~/.config/sapphire-agent/t3-token`, written by `scripts/mint-t3-token.sh` |
| Claude session transcripts | `~/.claude/projects` (override the directory holding `projects` with `CLAUDE_CONFIG_DIR`) |
| Projects | The journal's `projects` table, managed with `sapphire project` (below) |
| Journal | `journal.db` in the state directory |
| Pause file | `paused` in the state directory |

Config is read once at startup. Restart the service after editing (see `operations.md`).

## Fields

Decoded with an Effect `Schema`. The schema is strict: an unknown key fails startup naming the field (`Expected no excess property`).

| Field | Default | Notes |
| --- | --- | --- |
| `pollSeconds` | `600` | int, min 5. The backstop poll: the tick interval when nothing else wakes the reconciler. Linear webhook deliveries, ended thread waits, agent events and `sapphire` requests trigger extra ticks in between. Monitoring timers (`awaitingInputAfterSeconds`, `staleAfterSeconds` and the others) are checked only on ticks, so they can fire up to this long late, and an epic's transient failure is retried only on the next tick. |
| `maxInFlight` | `1` | int, min 1. Counts `claimed`, `running`, `stale` runs, follow-ups included. Command runs do not count (`rules.md`). |
| `dispatchSettleSeconds` | `60` | int, min 0. How old a ready epic must be (from its `createdAt`) before it is claimed, since an epic is often created before its sub-issues. |
| `awaitingInputAfterSeconds` | `180` | int, min 30. How long a command's thread may sit stopped without its agent saying it is done before the command fails. The old name `stuckAfterSeconds` is still read as this key. |
| `startTimeoutSeconds` | `300` | int, min 60. Time from the claim (or the process start, if later) for the run's T3 thread to be launched before the start fails. |
| `staleAfterSeconds` | `600` | int, min 60. A run's thread shows no progress for this long: nudge once. |
| `nudgeGraceSeconds` | `600` | int, min 60. Nothing the agent did itself this long after the nudge: run `stale`, epic flagged. |
| `maxRunSeconds` | `5400` | int, min 600. Wall-clock cap from the claim; the epic is flagged once, in any in-flight state. The run keeps going. |
| `handoffAtTokens` | `250000` | int, min 10000. Context (input, cache read and cache creation tokens of the latest assistant entry) at which a run's agent, or one of its subagents, hands its work to a fresh session (`rules.md`, Handoff). |
| `flagTransientAfterSeconds` | `600` | int, min 60. How long an epic's work may keep failing with Transient errors before a `transientFailure` notice is sent once (see `failure-policy.md`). Also how long observing may keep failing before Pushover is told once. |
| `worktreesDirectory` | `~/.t3/worktrees` | `~` expanded. Where T3 creates worktrees (T3's own setting, keep the two equal); the run guards treat `<worktreesDirectory>/<repo>/<branch slug>` as a dispatched run's worktree. |
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
| `pushover.appTokenFile` | `~/.config/sapphire-agent/pushover-app-token` | `~` expanded. The token of the Pushover application the service's notices about itself are sent with, see below. |
| `pushover.userKeyFile` | `~/.config/sapphire-agent/pushover-user-key` | `~` expanded. The Pushover user key they are sent to, see below. |
| `t3.url` | `http://127.0.0.1:3773` | The T3 Code server; its MCP endpoint is `<url>/mcp`. |
| `t3.tokenFile` | `~/.config/sapphire-agent/t3-token` | `~` expanded. The full-access T3 token, see below. |
| `t3.settingsFile` | `~/.t3/userdata/settings.json` | `~` expanded. T3's own settings, read at startup to check its worktree cleanup and auto-settle (`operations.md`, T3 settings), and at each launch for T3's default model. A missing file is T3's defaults for the check, but fails every launch: T3 must have a default model. |

`states` defaults: `ready` "Ready For Agent", `implementing` "Implementing", `inReview` "In Review", `toReview` "To Review", `shipped` "Shipped". All five must exist in a team or it is skipped.

## Projects

A project is a Linear team sapphire-agent watches, by its exact name, and the local clone its epics run in. Projects live in the journal (`projects`), not the config; the CLI checks each change (the team exists in Linear, the repo is a directory with a GitHub `origin`, the label repos directory exists) and records a request the service applies on its next tick (`rules.md`, Requests):

```sh
sapphire project list
sapphire project add Unbound ~/unbound --label-repos ~/unbound-app
sapphire project edit Unbound --repo ~/unbound
sapphire project remove Telecord   # refused while a run of the team is in flight
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

Live config today: `teams` Unbound (with `labelReposDirectory`), Telecord, Hivemind, and Sapphire Agent (this repo, `~/sapphire-agent`, so the service works on itself), imported as projects on the first start that has none, then to be deleted; `maxInFlight` 3, all other fields at their defaults. It needs `"linearWebhookSecretFile": "~/.config/sapphire-agent/linear-webhook-secret"` and this `bot` entry before this version starts:

```json
"bot": {
	"login": "orchestratorbot",
	"app": {
		"id": 123456,
		"privateKeyFile": "~/.config/sapphire-agent/app.pem",
		"webhookSecretFile": "~/.config/sapphire-agent/webhook-secret"
	},
	"allowedUsers": ["marioparaschiv"]
}
```

with the App's real ID (`operations.md` covers creating and installing the App).

The service also needs the two Pushover files at their default paths (or a `pushover` entry naming others); the CLI does not.
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

## Pushover app token and user key

- The API token of a Pushover application (pushover.net, Create an Application) and the user key from the Pushover dashboard, each as plain text in its own file; whitespace trimmed.
- Same rules as the API key for both: mode 600, else `... is readable by other users; run chmod 600 ...`; missing: `no Pushover app token: create <path> with mode 600` (or `user key`); empty fails; anything but 30 letters and digits fails with `<path> is not a Pushover app token: expected 30 letters and digits`.
- Only the service reads them (`PushoverConfig`); the CLI runs without them.

## T3 token

- A T3 session token (`<base64url JSON claims>.<signature>`) whose runtime-mode ceiling is full-access, so it may create projects and launch full-access threads. `scripts/mint-t3-token.sh` issues one with `t3 auth session issue` and re-signs its claims with `rtc: full-access`; T3 has no flag for that ceiling. No OAuth.
- Same rules as the API key: mode 600, else `... is readable by other users; run chmod 600 ...`; missing: `no T3 token: create <path> with mode 600`; a file whose claims do not decode, or carry no `exp`, fails with `<path> is not a T3 session token; run scripts/mint-t3-token.sh`. Its `exp` claim (epoch ms) is when it expires.
- Read by the service and the CLI (`T3Config`). When T3 rejects it (HTTP 401), see `failure-policy.md`.

## Env vars

Read with Effect `Config`. None is required: each has a default in code (`src/config.ts`, `src/directories.ts`), so neither `systemd/sapphire-agent.service` nor `scripts/ctl.sh` sets them, and a command thread's `ctl.sh` reaches the same journal and config. An empty value counts as unset.

| Var | Default |
| --- | --- |
| `SAPPHIRE_AGENT_CONFIG_DIR` | `~/.config/sapphire-agent` |
| `SAPPHIRE_AGENT_STATE_DIR` | `~/.local/state/sapphire-agent` |
| `SAPPHIRE_AGENT_LINEAR_KEY_FILE` | `~/.config/sapphire-agent/linear-key` |
| `CLAUDE_CONFIG_DIR` | `~/.claude`, as Claude Code reads it |

## Startup errors

The config file, the API key, the Linear webhook secret, the App's private key and webhook secret and the Pushover app token and user key are all checked before anything runs, and every problem is reported together in one `StartupError`, logged once, after which the process exits non-zero. The CLI (`ctl.ts`) checks the same minus the Pushover files, which only the service uses:

```
StartupError: cannot start, fix these and restart:
- /home/dev/.config/sapphire-agent/config.json pollSeconds: Expected a value greater than or equal to 5
- /home/dev/.config/sapphire-agent/config.json maxInflight: Expected no excess property
- no Linear API key: create /home/dev/.config/sapphire-agent/linear-key with mode 600
- /home/dev/.config/sapphire-agent/app.pem is readable by other users; run chmod 600 /home/dev/.config/sapphire-agent/app.pem
- no Pushover user key: create /home/dev/.config/sapphire-agent/pushover-user-key with mode 600
```

A file whose path comes from an invalid config file is not read; that problem is already reported. Startup also stops while the old dispatcher's `claims.json` still holds claims (`operations.md`).
