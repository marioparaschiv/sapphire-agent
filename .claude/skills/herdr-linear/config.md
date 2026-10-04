# Config

Where configuration lives, every field with its default (`src/config.ts`), the team-to-repo mapping, the API key file and the env vars `main.ts` reads.

## Files

| What | Path |
| --- | --- |
| Config | `$HERDR_PLUGIN_CONFIG_DIR/config.json` = `~/.config/herdr/plugins/config/herdr-linear/config.json` |
| Linear API key | `~/.config/herdr-linear/linear-key` (override `HERDR_LINEAR_KEY_FILE`) |
| Claude config (trust) | `~/.claude.json` (override `CLAUDE_CONFIG_PATH`) |

Config is read once at startup. Restart the service after editing (see `operations.md`).

## Fields (`config.ts:18-44`)

The schema is strict: unknown keys fail startup with a zod error naming the field.

| Field | Default | Notes |
| --- | --- | --- |
| `pollSeconds` | `30` | int, min 5. Linear poll interval, worker reconcile interval, event resubscribe delay. |
| `maxInFlight` | `1` | int, min 1. Counts `claimed`, `running`, `awaitingInput`, `stale` claims. |
| `awaitingInputAfterSeconds` | `180` | int, min 30. Quiet (`idle` / `done` / `blocked`) time before flagging an agent with no PR as `awaitingInput`. Was `stuckAfterSeconds`. |
| `startTimeoutSeconds` | `300` | int, min 60. Time from claim (or dispatcher start) for the worker to confirm Claude started before the claim becomes `error`. Covers queueing behind other starts, the fetch and herdr's 30 s start wait. |
| `worktreesDirectory` | `~/.herdr/worktrees` | `~` expanded. |
| `workspaceLabel` | `agents` | herdr workspace that holds the run tabs. |
| `states.*` | see below | Exact Linear workflow state names. |
| `labels.stuck` | `agent-stuck` | Label added when a claim becomes `awaitingInput`, `stale` or `error`. |
| `labels.repoPrefix` | `repo:` | Repo label prefix; group name is this minus trailing `:`. |
| `teams` | required | At least one team. |

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

Live config today: teams Unbound (with `labelReposDirectory`), Telecord, Hivemind, and Herdr Linear (this repo, `~/herdr-linear`, so the plugin works on itself); `maxInFlight` 3, all other fields at their defaults.

## API key

- Plain text file containing a Linear personal API key; whitespace trimmed.
- Must not be readable by group or others (`mode & 0o077` must be 0), so use `chmod 600`. Otherwise startup fails with `... is readable by other users; run chmod 600 ...` (`main.ts:26-42`).
- Missing file: `no Linear API key: create <path> with mode 600`. Empty file also fails.

## Env vars (`main.ts:14-21`)

Set by `systemd/herdr-linear.service`; all validated with zod at startup.

| Var | Required | Value in the unit |
| --- | --- | --- |
| `HERDR_BIN_PATH` | yes | `%h/.local/bin/herdr` |
| `HERDR_SOCKET_PATH` | yes | `%h/.config/herdr/herdr.sock` (default session) |
| `HERDR_PLUGIN_CONFIG_DIR` | yes | `%h/.config/herdr/plugins/config/herdr-linear` |
| `HERDR_PLUGIN_STATE_DIR` | yes | `%h/.local/state/herdr/plugins/herdr-linear` |
| `HERDR_LINEAR_KEY_FILE` | no | default `~/.config/herdr-linear/linear-key` |
| `CLAUDE_CONFIG_PATH` | no | default `~/.claude.json` |
