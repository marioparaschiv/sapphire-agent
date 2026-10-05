# Architecture

How the reconciler is put together: one tick, the rules and their order, the webhook server, the services, startup, and which module owns what.

## The reconciler

One level-triggered loop. There is no dispatcher and worker split, no message protocol and no in-memory run state. Each tick:

1. The `Observer` reads the outside world once: Linear, herdr, git (and nothing from the journal).
2. The `Planner` hands that observation to each rule in order. A rule reads the journal itself, decides what to do per epic, and returns at most one piece of work per epic (`EpicWork`). Work that is not about an epic (a command, a request whose epic has no run) is a `TaskWork`, named by a task such as `CMD-3`.
3. The planner runs that rule's work, each piece in its own fiber under the failure policy (`failure-policy.md`), waits for all of it, then moves on to the next rule.

Because every decision is made from what is observed now plus the journal, a missed herdr event, a crash or a restart never leaves state wrong: the next tick sees the same world and carries on. Every external write is idempotent (a marker check, a state check, or a write that is a no-op when already done), so doing a step again is safe.

The `Reconciler` service ticks at once on start, then every `pollSeconds`, and once more whenever `wake` is called. Wakes and polls that arrive during a tick collapse into one more tick. `main.ts` calls `wake` on every herdr event, so an agent status change is acted on within moments, while the poll always overrides what the socket said. It also calls `wake` whenever the file `wake` in the state directory is written, which `scripts/ctl.sh` does after recording a request, so a command's request is acted on at once. The webhook server calls `wake` once it queued a command, so a mention starts its command at once.

## One tick

The observation (`Observation`) holds:

| Field | What |
| --- | --- |
| `teams` | Configured teams found in Linear with every configured workflow state, by team id. A team that is missing, or lacks a state, is left out and its epics are not touched. |
| `epics` | Every epic the journal tracks (wherever it is now), every ready epic, and the epics named by owned tabs and worktree branches. |
| `ready` | Top-level epics in a team's ready state, at most 50. |
| `tabs` | Every tab in the sapphire-agent workspace, renamed ones included. |
| `worktrees` | Every worktree under the worktrees directory of a configured or tracked repo, herdr's own included. |

Rules run in this order (`rules.ts`):

| # | Rule | Pausable | Does |
| --- | --- | --- | --- |
| 1 | requests | no | Acts on `ctl.sh stop` (ends the run, closes its tab) and `ctl.sh send` (types into the agent); drops follow-up requests whose epic has no run. |
| 2 | cleanup | no | Ends what is left of finished runs (tab, worktree, branch, row), and resolves owned tabs and worktrees that no run tracks. |
| 3 | results | no | Ends runs whose epic moved on; reads, stores and posts result files; moves the epic to To Review. |
| 4 | monitoring | no | Tracks agent status and pane output; flags awaitingInput, stale, error and the wall-clock cap; nudges; relays replies. |
| 5 | follow-up | yes | Claims a follow-up run for a follow-up request, once the epic's run ended. |
| 6 | dispatch | yes | Claims ready epics up to `maxInFlight`. |
| 7 | start | no | Takes each claimed run through worktree, trust, tab, Claude and the move to Implementing. |
| 8 | commands | no | Runs the command agents one at a time: starts the next, watches the running one, posts its replies as the GitHub App, ends it when it is done or fails it. |

Why this order: requests come first, so a stopped run is ended before any other rule looks at it. Cleanup and results end runs before monitoring looks at them, so one tick never flags a run it just ended. Claims come next, follow-ups before ready epics since both count against `maxInFlight`, so the start rule starts them in the same tick. Commands are not pausable: `resume` itself comes in as a command. Rules run one after another, so two rules never act on the same epic at once, and each sees in the journal what the rules before it wrote. A rule that takes over a tab checks herdr again first, since an earlier rule may have closed it this tick.

Pausing (`scripts/ctl.sh pause`) skips the pausable rules only: nothing new is claimed, but claimed runs still start, runs in flight are still watched, posted and cleaned up, and mentions still run commands. If the pause file cannot be read, the tick runs as paused.

Each rule details: `rules.md`.

## The webhook server

Mentions are not a rule: they arrive as GitHub App webhook deliveries. `WebhookServer` (`webhook-server.ts`) is an Effect-managed `node:http` server (`NodeHttpServer`) on `127.0.0.1:<bot.app.webhookPort>`, built as a layer beside the reconciler, so it listens while the service runs and closes on shutdown. nginx terminates TLS at `https://webhook.marioparaschiv.com/github` and forwards to it (`operations.md`). Each delivery's signature is checked against the webhook secret, its payload is decoded with `Schema`, and a comment that mentions the bot is recorded as a command by `makeRecordMention` (`mentions.ts`, which holds the mention and allowed-user decisions), before the delivery is answered. See `rules.md` (Mentions).

GitHub does not redeliver a failed delivery by itself. `MissedDeliveries` (`missed-deliveries.ts`), forked by `main.ts` beside the reconciler, scans the App's delivery log at startup and every `deliveryScanSeconds` and asks GitHub to redeliver each event whose newest attempt failed, back to 10 minutes before the journal's delivery mark and at most 3 days. The redeliveries arrive at the webhook server like any other. A failed scan is logged and tried again on the next. See `rules.md` (Missed deliveries).

## Services

Each is an Effect `Context.Service` with a live layer; the externals have a test layer.

| Service | Module | Does | Test layer |
| --- | --- | --- | --- |
| `AppConfig` | `config.ts` | Env, config file, API key and the GitHub App's private key and webhook secret, read once at startup. | `AppConfig.layerTest(dir, settings)` |
| `Linear` | `linear.ts` | GraphQL over `HttpClient`: teams, epics, replies, comments, moves, labels, reactions. | `LinearFixture.layer`: a real HTTP server with the real `Linear` layer pointed at it. |
| `GitHub` | `github.ts` | `gh` CLI: PR lookup, summary, flags review, thread replies and resolves as the user; comments as the GitHub App. | `FakeGitHub.layer` |
| `GitHubApp` | `github-app.ts` | GitHub App auth over `HttpClient`: its `<slug>[bot]` login, read at startup, installation tokens, cached per installation, and the App's webhook delivery log: a page of it and a redelivery. | `GitHubAppFixture.layer`: a real HTTP server with the real `GitHubApp` layer pointed at it. |
| `Herdr` | `herdr.ts` | herdr CLI and event socket: workspaces, tabs (with extra shell variables), panes, agents, prompts, starting Claude (with extra arguments). | `FakeHerdr.layer` |
| `Git` | `git.ts` | Worktrees, pull, unsaved-work check, removal, origin's GitHub repo, the result file. | Real git in temp repos. |
| `ClaudeTrust` | `claude-trust.ts` | Pre-accepts Claude's folder trust in `~/.claude.json`. | Real temp files. |
| `Journal` | `journal.ts` | SQLite journal of runs, transient failure streaks, commands and requests. | `Journal.layer(':memory:')` or a temp file. |
| `Pause` | `pause.ts` | Whether the pause file exists. | Real temp dir. |
| `Prompts` | `prompts.ts` | Tab labels and the orchestrate, follow-up and command prompts. | Pure. |
| `Comments` | `comments.ts` | Every Linear and PR comment body, each ending with its marker. | Pure. |
| `Observer` | `observation.ts` | One observation per tick. | Real, over the test layers. |
| `Planner` | `planner.ts` | Runs the rules under the failure policy. | Real. |
| `Reconciler` | `reconciler.ts` | The tick loop and `wake`. | Real. |
| `WebhookServer` | `webhook-server.ts` | GitHub App webhook deliveries in, commands recorded, the reconciler woken; exposes the `url` it listens on. | Real, on port 0 (`makeHarness` builds it; `h.deliver` posts signed deliveries). |
| `MissedDeliveries` | `missed-deliveries.ts` | `scan` redelivers failed webhook deliveries back to 10 minutes before the delivery mark; `run` scans at once and every `deliveryScanSeconds`. | Real, against `GitHubAppFixture` (`makeHarness` builds it; `h.scanDeliveries` runs one scan). |

Rules are not services: each rule module exports an Effect that builds its `Rule` (`name`, `pausable`, `plan`) from the services it needs, and `Planner.layer` takes them all. Shared run actions (flag an epic, close a run's tab, end a run, nudge an agent) live in `run-actions.ts`.

## Startup (`main.ts`)

1. `AppConfig.layer` reads env, the config file, the API key and the GitHub App's private key and webhook secret and reports every problem in one `StartupError` (one log line listing them all), then exits non-zero. See `config.md`.
2. `refuseUndrainedClaims` (`legacy-claims.ts`) stops startup while `$HERDR_PLUGIN_STATE_DIR/claims.json` of the old dispatcher still holds claims, and says to drain first (`operations.md`).
3. Only then are the services built: the journal opens `$HERDR_PLUGIN_STATE_DIR/journal.db` and runs its migrations, `GitHubApp` reads the App's slug from GitHub (`GET /app`), and the webhook server starts listening (logging `listening for GitHub webhook deliveries on <url>`). A failure there, e.g. the port taken, stops startup.
4. Logs `watching <teams> every <n>s, at most <n> in flight`, forks a fiber that calls `wake` on every herdr event, one that calls it whenever the state directory's `wake` file is written and one that runs the delivery scan, and runs the reconciler.

`NodeRuntime.runMain` runs it; SIGTERM interrupts the tick cleanly. Logs go to stdout with `epic` and `rule` annotations.

`ctl.ts` is a second entry point, the CLI behind `scripts/ctl.sh` (Effect's `cli` module): `status`, `start`, `stop`, `send`, `follow-up`, `reply`, `done`. It opens the same journal file while the service runs (WAL mode and a 5 s busy timeout, the SQLite client's defaults) and only appends requests to it, so it never races a rule over a row; `start` moves the epic in Linear itself, which is idempotent. A refusal (e.g. `stop` for an epic with no run in flight) is printed on stderr with exit code 1.

## File map

| File | Role |
| --- | --- |
| `src/main.ts` | Entry point: layers, startup guard, event wakes, reconciler, webhook server. |
| `src/ctl.ts` | The CLI behind `ctl.sh`: status, start, stop, send, follow-up, reply, done. |
| `src/reconciler.ts` | Tick loop, poll interval, wakes, pause logging. |
| `src/planner.ts` | `Rule`, `EpicWork`, the planner and the failure policy at the epic level. |
| `src/observation.ts` | `Observer` and helpers shared by rules (roles, in-flight statuses, tab matching, agent status). |
| `src/rules.ts` | Every rule in order. |
| `src/dispatch.ts` | Dispatch and start rules, repo resolution, claims, tab adoption. |
| `src/monitoring.ts` | Monitoring rule. |
| `src/results.ts` | Results rule and posting a result to the PR. |
| `src/follow-up.ts` | Follow-up rule. |
| `src/requests.ts` | Requests rule (stop, send). |
| `src/mentions.ts` | Records a comment that mentions the bot as a command (`makeRecordMention`). |
| `src/webhook-server.ts` | Webhook server: signature check, payload schemas, recording mentions, waking the reconciler. |
| `src/commands.ts` | Commands rule, the command agent's lockdown. |
| `src/cleanup.ts` | Cleanup rule and orphans. |
| `src/run-actions.ts` | Flag, close a run's tab, end a run, nudge. |
| `src/journal.ts` | Journal service, schema and migrations. |
| `src/markers.ts` | Marker format and parsing. |
| `src/comments.ts` | Comment texts. |
| `src/prompts.ts` | Tab label and prompts. |
| `src/result-file.ts` | Result file schema. |
| `src/call-policy.ts` | `Transient`, `Permanent`, timeouts and retries for every external call. |
| `src/config.ts` | Config schema, env, API key, App private key and webhook secret, `StartupError`. |
| `src/legacy-claims.ts` | Startup guard against an undrained `claims.json`. |
| `src/linear.ts`, `src/github.ts`, `src/github-app.ts`, `src/herdr.ts`, `src/git.ts`, `src/claude-trust.ts`, `src/pause.ts` | The external services. |
| `src/linear-fixture.ts`, `src/github-app-fixture.ts`, `src/fixture-server.ts`, `src/github-fake.ts`, `src/herdr-fake.ts`, `src/test-harness.ts` | Test layers and the harness (see `development.md`). |
| `src/fixtures/herdr/` | Real herdr JSON output and events, recorded from a named session, for the herdr tests. |
| `src/*.test.ts` | Tests beside the code. |
