# Architecture

How the reconciler is put together: one tick, the rules and their order, the webhook server, the agent event server, outages sent to Pushover, the services, startup, the CLI, and which module owns what.

## The reconciler

One level-triggered loop. There is no dispatcher and worker split, no message protocol and no in-memory run state. Each tick:

1. The `Observer` reads the outside world once: Linear, git and the runs' T3 threads (and nothing from the journal but which runs exist).
2. The `Planner` hands that observation to each rule in order. A rule reads the journal itself, decides what to do per epic, and returns at most one piece of work per epic (`EpicWork`). Work that is not about an epic (a command, a request whose epic has no run) is a `TaskWork`, named by a task such as `CMD-3`.
3. The planner runs that rule's work, each piece in its own fiber under the failure policy (`failure-policy.md`), waits for all of it, then moves on to the next rule.

Because every decision is made from what is observed now plus the journal, a missed wake, a crash or a restart never leaves state wrong: the next tick sees the same world and carries on. Every external write is idempotent (a marker check, a state check, or a write that is a no-op when already done), so doing a step again is safe.

The `Reconciler` service ticks at once on start, then every `pollSeconds`, and once more whenever `wake` is called. Wakes and polls that arrive during a tick collapse into one more tick. `main.ts` calls `wake` whenever the file `wake` in the state directory is written, which the CLI does after recording a request, a pause or a resume, so it is acted on at once. The webhook server calls `wake` once it queued a command, so a mention starts its command at once, and on every signed Linear delivery, so a change in Linear is acted on at once. `watchThreads` (`thread-waits.ts`) keeps one `t3_thread_wait` open (4 min at a time, opened again when it only timed out) on the thread of each T3 run in flight and of each command claimed or running, read from the journal every 5 s, and calls `wake` once it returns, so a run that finished, failed or was interrupted is acted on within seconds; after a restart it opens the waits of the runs in flight again. A change to the projects (`Projects.changes`) wakes it too, so a project the requests rule added or removed is observed on the next tick. Because of these wakes the poll is only a backstop, every 10 minutes by default; a Linear delivery missed while the service was down is covered by the tick at startup and the poll.

## One tick

The observation (`Observation`) holds:

| Field | What |
| --- | --- |
| `teams` | The projects' teams found in Linear with every configured workflow state, by team id. A team that is missing, or lacks a state, is left out and its epics are not touched. |
| `epics` | Every epic the journal has a run of (wherever it is now), every ready epic, and the epics named by worktree branches. |
| `ready` | Top-level epics in a team's ready state, at most 50. |
| `worktrees` | Every worktree under the worktrees directory of a project's or a run's repo. |
| `threads` | The T3 thread of every run that is not over (`t3_thread_read`, then its newest 5 timeline items, and `t3_thread_list` of its project's unsettled threads for its subagents): its status, title, worktree, pending requests and last progress, by thread id. A thread T3 no longer has is left out; one T3 could not be asked about is `unknown`, which counts as working. |

Rules run in this order (`rules.ts`):

| # | Rule | Pausable | Does |
| --- | --- | --- | --- |
| 1 | requests | no | Applies `sapphire project add`, `edit` and `remove`; acts on `ctl.sh stop` (interrupts the run's T3 thread, ends the run), `ctl.sh send` (sends to the agent's thread) and `session` (a run's agent started another session); drops follow-up requests whose epic has no run. |
| 2 | cleanup | no | Ends what is left of finished runs (thread, worktree, branch, row), and resolves owned worktrees that no run tracks. |
| 3 | results | no | Ends runs whose epic moved on; reads, stores and posts result files; moves the epic to To Review. |
| 4 | monitoring | no | Tracks each run's thread progress; nudges a stalled run, flags it stale and the wall-clock cap; tells Pushover of a question waiting in a thread. |
| 5 | handoff | no | Takes a run's agent whose context reached `handoffAtTokens` through `/handoff` and on to a fresh thread. |
| 6 | follow-up | yes | Claims a follow-up run for a follow-up request, once the epic's run ended. |
| 7 | dispatch | yes | Claims ready epics up to `maxInFlight`. |
| 8 | start | no | Takes each claimed run through its T3 thread and the move to Implementing; records a run's worktree once T3 made it. |
| 9 | epic-edits | no | Tells a run's agent, in one message per debounce window, of edits to its epic or sub-issues since the snapshot, leaving out the ones the bot makes by design and Linear's automations. |
| 10 | commands | no | Runs the command agents one at a time: starts the next, watches the running one, posts its replies on GitHub as the bot, ends it when it is done or fails it. |
| 11 | notices | no | Posts the journal's outbox of notices as comments on their epics in Linear. |

Why this order: requests come first, so a stopped run is ended before any other rule looks at it. Cleanup and results end runs before monitoring looks at them, so one tick never flags a run it just ended. Handoffs follow monitoring, which records when the thread last showed progress. Claims come next, follow-ups before ready epics since both count against `maxInFlight`, so the start rule starts them in the same tick. Epic edits follow the start, so a run claimed this tick has its epic snapshotted after the start moved it. Notices go last, so what every rule wrote this tick is posted in it. Commands are not pausable: `resume` itself comes in as a command. Rules run one after another, so two rules never act on the same epic at once, and each sees in the journal what the rules before it wrote.

Pausing (`sapphire pause`) skips the pausable rules only: nothing new is claimed, but claimed runs still start, runs in flight are still watched, posted and cleaned up, and mentions still run commands. If the pause file cannot be read, the tick runs as paused and Pushover is told (Outages).

Each rule details: `rules.md`.

## The webhook server

Mentions are not a rule: they arrive as GitHub App webhook deliveries. `WebhookServer` (`webhook-server.ts`) is an Effect-managed `node:http` server (`NodeHttpServer`) on `127.0.0.1:<bot.app.webhookPort>`, built as a layer beside the reconciler, so it listens while the service runs and closes on shutdown. nginx terminates TLS at `https://webhook.marioparaschiv.com/github` and forwards to it (`operations.md`). Linear's deliveries come to the same server on `/linear`, exposed by Tailscale Funnel (`operations.md`); each one's `Linear-Signature` is checked against the Linear webhook secret, and a signed one only wakes the reconciler, which reads Linear itself, so a duplicate or out-of-order delivery is harmless. On every other path, each GitHub delivery's signature is checked against the webhook secret, its payload is decoded with `Schema`, and a comment that mentions the bot is recorded as a command by `makeRecordMention` (`mentions.ts`, which holds the mention and allowed-user decisions), before the delivery is answered. See `rules.md` (Mentions).

## The agent event server

`AgentEventServer` (`agent-event-server.ts`), a layer beside the webhook server, listens on `$STATE/events.sock` for the session events the coding agents' hooks send through `sapphire hook <agent>`. It decodes each with that agent's adapter, wakes the reconciler for an event in a run's worktree or a command's checkout (the event's `cwd`) (not on every tool call), records a `session` request on the first event of a run's agent in a new session, and checks a run's context after a tool call or a turn's end (`makeContextCheck`, `handoffs.ts`). Its answer carries what the hook prints, which tells a subagent to hand off. See `rules.md` (Agent events, Handoff).

## Outages

A failure of the whole service rather than of one epic goes to the user's phone through `Pushover` (`pushover.ts`). `makeOutage` (`outages.ts`) tracks one kind of failure as a streak in memory: each failure extends it, the first success ends it, and Pushover hears of each streak once, as soon as it has lasted the given time. A send that fails is logged (`cannot send the notice to Pushover; trying again at the next failure`) and tried again at the next failure. A restart during a streak starts a new one. With `renoticeAfterSeconds`, Pushover hears of it again only once that long has passed since its last notice, across streaks.

| Title | Sent by | When | Priority |
| --- | --- | --- | --- |
| `sapphire-agent cannot observe` | `Planner` | Observing (Linear or the journal) has failed for `flagTransientAfterSeconds`; no epic is dispatched or watched. | high |
| `sapphire-agent cannot read its pause file` | `Reconciler` | At the first failure to read the pause file; no new run starts. | high |
| `T3 rejects the sapphire-agent token` | `Reconciler` | T3 answers the tick's `ping` with HTTP 401; no new run starts. Says to run `scripts/mint-t3-token.sh` again. At most once a day. | high |

Priority `high` (Pushover's 1) is for what stops dispatch, `normal` (0) for the rest. The table lists the outages only. Notices about one epic are comments on the epic (`rules.md`, Notices); a few also reach the phone at normal priority, besides the comment: a run flagged stale or waiting on a question (monitoring), a worktree kept for unsaved work (cleanup), a dispatched run's turn ending or asking for input (`run-hooks.ts`), and T3's settings needing a change (startup).

## Services

Each is an Effect `Context.Service` with a live layer; the externals have a test layer.

| Service | Module | Does | Test layer |
| --- | --- | --- | --- |
| `AppConfig` | `config.ts` | Env, config file, API key, Linear webhook secret and the GitHub App's private key and webhook secret, read once at startup. | `AppConfig.layerTest(dir, settings)` |
| `PushoverConfig` | `config.ts` | The Pushover app token and user key; read by the service only, in the same pass as `AppConfig` (`PushoverConfig.layerWithAppConfig`), so the CLI runs without them. | `Layer.succeed(PushoverConfig, ...)` |
| `T3Config` | `config.ts` | T3's URL and the token from `t3.tokenFile`, with its expiry from the `exp` claim; read by the service and the CLI. | `T3Config.layerTest` |
| `T3` | `t3.ts` | MCP client of T3 Code over `HttpClient` (`POST <url>/mcp`, bearer token): opens a session (`initialize`, then `notifications/initialized`; `mcp-session-id` and `mcp-protocol-version` on every later request), reopens it on a 404, reads JSON or server-sent event replies and prefers `structuredContent`. `ping`, projects (list, create) and threads (launch, list, read, wait, send, interrupt, settle), each result decoded to the fields the rules use. | `FakeT3.layer`: in-memory projects, threads, runs, subagents and settling, under the same call policy; `rejectToken` and `hang`. The live layer is tested against a local MCP server answering recorded results (`src/fixtures/t3`). |
| `T3Projects` | `t3-projects.ts` | `projectFor(repo)`: the T3 project id of a team repo or a label repo, from the journal, else T3's project with that workspace root, else a new one; remembered in the journal, one lookup at a time. | Real, over `FakeT3`. |
| `Linear` | `linear.ts` | GraphQL over `HttpClient`: teams, epics, the trees of epics in flight and their history, moves, labels, comments (`PR opened` and the notices). | `LinearFixture.layer`: a real HTTP server with the real `Linear` layer pointed at it. |
| `GitHub` | `github.ts` | `gh` CLI: PR lookup as the user; thread replies and resolves, issue and PR comments and thumbs-ups as the GitHub App. | `FakeGitHub.layer` |
| `GitHubApp` | `github-app.ts` | GitHub App auth over `HttpClient`: its `<slug>[bot]` login, read at startup, and installation tokens, cached per installation. | `GitHubAppFixture.layer`: a real HTTP server with the real `GitHubApp` layer pointed at it. |
| `Git` | `git.ts` | Worktrees, pull, unsaved-work check, removal, origin's GitHub repo, the result file. | Real git in temp repos. |
| `ClaudeTranscript` | `claude-transcript.ts` | Reads the context of a run's Claude session or one of its subagents from its transcript in `~/.claude/projects` (`contextTokens`, reading only what was appended since the last call). | Real temp files, written by `claude-transcript-fixture.ts`. |
| `Journal` | `journal.ts` | SQLite journal of runs, transient failure streaks, commands, requests, projects, notices, subagent handoffs, the T3 project of each repo and the snapshots of the epics in flight. | `Journal.layer(':memory:')` or a temp file. |
| `Projects` | `projects.ts` | The projects, read from the journal at startup (importing config `teams` into an empty table) and kept in memory; `list`, `get`, `put`, `remove`, `changes`. Its only writer. | Real, over the journal. |
| `Pause` | `pause.ts` | The pause file: its `path`, whether it exists, and `pause` and `resume`, which create and remove it. | Real temp dir. |
| `Prompts` | `prompts.ts` | Thread titles, the orchestrate, follow-up and command prompts, and the handoff prompts. | Pure. |
| `Comments` | `comments.ts` | Every notice and the few other Linear and GitHub comment bodies, each with its marker. | Pure. |
| `Observer` | `observation.ts` | One observation per tick, the T3 threads of the runs included. | Real, over the test layers. |
| `Planner` | `planner.ts` | Runs the rules under the failure policy. | Real. |
| `Reconciler` | `reconciler.ts` | The tick loop and `wake`. | Real. |
| `WebhookServer` | `webhook-server.ts` | GitHub App webhook deliveries in, commands recorded, the reconciler woken; Linear deliveries in, the reconciler woken; exposes the `url` it listens on. | Real, on port 0 (`makeHarness` builds it; `h.deliver` posts signed deliveries). |
| `AgentEventServer` | `agent-event-server.ts` | Agent session events in from `sapphire hook`, `session` requests recorded, the reconciler woken; exposes the socket `path`. | Real, on a socket in the harness's dir (`h.hook` runs the real `ctl.sh hook`). |
| `Summariser` | `summariser.ts` | `summarise(prompt)`: `claude -p --model <summaryModel>` with the prompt on stdin, no tools and no saved session; one attempt with a 60 s timeout. Fails Permanent on a non-zero exit. | `FakeSummariser.layer` |
| `Pushover` | `pushover.ts` | `send`: a phone notification (`POST https://api.pushover.net/1/messages.json`, form `token`, `user`, `title`, `message`, optional `url`, `priority`) under the write policy; 5xx are Transient, other non-2xx Permanent with Pushover's `errors` (a 429 is the monthly message limit, which a retry cannot help). | `FakePushover.layer` |

Rules are not services: each rule module exports an Effect that builds its `Rule` (`name`, `pausable`, `plan`) from the services it needs, and `Planner.layer` takes them all. Shared run actions (flag an epic, end a run, and interrupt, settle or send to a run's or command's thread) live in `run-actions.ts`. The context check of the agent event server (`makeContextCheck`) lives beside the handoff rule in `handoffs.ts`.

## Startup (`main.ts`)

1. `PushoverConfig.layerWithAppConfig` reads env, the config file, the API key, the Linear webhook secret, the GitHub App's private key and webhook secret and the Pushover app token and user key, and reports every problem in one `StartupError` (one log line listing them all), then exits non-zero. See `config.md`.
2. `refuseUndrainedClaims` (`legacy-claims.ts`) stops startup while `$STATE/claims.json` of the old dispatcher still holds claims, and says to drain first (`operations.md`).
3. Only then are the services built: the journal opens `$STATE/journal.db` and runs its migrations, `Projects` reads the projects (importing config `teams` while there are none, and warning while `teams` is in the config), `GitHubApp` reads the App's slug from GitHub (`GET /app`), `T3Config` reads the T3 token (a problem with it is a `StartupError` of its own), the webhook server starts listening (logging `listening for GitHub webhook deliveries on <url> and Linear ones on <url>/linear`), and so does the agent event server (`listening for agent events on <path>`). A failure there, e.g. the port taken, stops startup.
4. Checks T3's settings file (`t3.settingsFile`) for the projects' repos and tells Pushover once if T3 would remove their worktrees itself or not settle merged threads (`checkT3Settings`, `t3-settings.ts`; no MCP tool reads or changes them).
5. Logs `watching <projects> every <n>s, at most <n> in flight` (`no projects` without any), forks a fiber that runs `watchThreads`, one that runs `wakeForEpicEdits`, one that calls it on every change to the projects and one that calls `wake` whenever the state directory's `wake` file is written, and runs the reconciler.

`NodeRuntime.runMain` runs it; SIGTERM interrupts the tick cleanly. Logs go to stdout with `epic` and `rule` annotations.

`ctl.ts` is a second entry point, the CLI behind `scripts/ctl.sh` (Effect's `cli` module): `status`, `pause`, `resume`, `dispatch`, `stop`, `send`, `follow-up`, `session`, `reply`, `done`, `project list|add|edit|remove`, `t3 status`. It opens the same journal file while the service runs (WAL mode and a 5 s busy timeout, the SQLite client's defaults) and only appends requests to it, so it never races a rule over a row; `dispatch` moves the epic in Linear itself, which is idempotent, and `pause` and `resume` write and remove the `paused` file. Each touches the `wake` file. `project add` and `edit` check the team in Linear and the paths before they record the request. A refusal (e.g. `stop` for an epic with no run in flight) is printed on stderr with exit code 1.

## File map

| File | Role |
| --- | --- |
| `src/main.ts` | Entry point: layers, startup guard, wakes, reconciler, webhook server. |
| `src/directories.ts` | The default config and state directories, the commands directory, `ctl.sh`'s path and the handoff doc path (node built-ins only, for the agent hook). |
| `src/ctl.ts` | The CLI behind `ctl.sh`: status, pause, resume, dispatch, stop, send, follow-up, session, reply, done, project. |
| `src/projects.ts` | `Projects` service, `projectInRepo`. |
| `src/t3.ts` | `T3` service: the MCP client, its schemas and errors (`T3Unauthorized`, `T3ToolFailure`), `t3Policy`. |
| `src/t3-fake.ts` | `FakeT3`, and `t3TokenExpiring` for tests. |
| `src/t3-projects.ts` | `T3Projects` service. |
| `src/thread-waits.ts` | `watchThreads`: a `t3_thread_wait` per T3 run in flight and per command thread, waking the reconciler when it returns. |
| `src/t3-settings.ts` | `t3SettingsProblems`, `checkT3Settings`: T3's worktree cleanup and auto-settle settings for the projects, checked at startup. `defaultModelSelection`: T3's default model, which `T3.launchThread` passes to every launch. |
| `src/reconciler.ts` | Tick loop, poll interval, wakes, pause logging, the pause file outage, the T3 token check and its outage. |
| `src/planner.ts` | `Rule`, `EpicWork`, the planner, the failure policy at the epic level, the observing outage. |
| `src/observation.ts` | `Observer` and helpers shared by rules (roles, in-flight statuses, whether a run's agent works). |
| `src/rules.ts` | Every rule in order. |
| `src/dispatch.ts` | Dispatch and start rules, repo resolution, claims. |
| `src/monitoring.ts` | Monitoring rule. |
| `src/results.ts` | Results rule and posting a result (thread replies, the Linear and PR comments, the notices). |
| `src/follow-up.ts` | Follow-up rule. |
| `src/requests.ts` | Requests rule (project, stop, send, session). |
| `src/handoffs.ts` | Handoff rule, the context check and the handoff doc paths. |
| `src/mentions.ts` | Records a comment that mentions the bot as a command (`makeRecordMention`). |
| `src/webhook-server.ts` | Webhook server: signature checks, payload schemas, recording mentions, waking the reconciler for mentions and Linear deliveries. |
| `src/agent-hook.ts` | `sapphire hook <agent>`: sends a hook payload to the agent event server; Claude's `PreToolUse`, `Stop` and `Notification` also go to `run-hooks.ts`. |
| `src/run-hooks.ts` | In the hook process: a dispatched run's tool calls guarded, its turn ends and notifications sent to Pushover; a command thread's tool calls allowed or refused. |
| `src/run-guards.ts` | What the run guards refuse: dispatched worktree detection, git push/add/commit in Bash commands, file writes; and what a command thread may run (`commandToolDecision`, `isCommandCwd`). |
| `src/agent-event-server.ts` | Agent event server and the adapter per agent. |
| `src/agent-event.ts` | `AgentEvent`, agent-neutral, and the adapter type. |
| `src/agent-activity.ts` | `AgentActivity`: when each T3 run's agent or subagents last sent a hook event, in memory, for monitoring. |
| `src/claude-hooks.ts` | Claude Code's hook payloads to `AgentEvent`. |
| `src/notices.ts` | Notices rule: the outbox to comments on the epics. |
| `src/epic-edits.ts` | Epic edits rule and `wakeForEpicEdits`. |
| `src/summariser.ts` | `Summariser` service. |
| `src/outages.ts` | `makeOutage`: a failure streak of the whole service, sent to Pushover once. |
| `src/commands.ts` | Commands rule. |
| `src/cleanup.ts` | Cleanup rule and orphans. |
| `src/run-actions.ts` | Flag, end a run, interrupt, settle and send to a T3 thread. |
| `src/journal.ts` | Journal service, schema and migrations. |
| `src/markers.ts` | Marker purposes, format and parsing. |
| `src/comments.ts` | Notice and comment texts. |
| `src/prompts.ts` | Thread titles and prompts. |
| `src/result-file.ts` | Result file schema. |
| `src/call-policy.ts` | `Transient`, `Permanent`, timeouts and retries for every external call. |
| `src/config.ts` | Config schema, env, API key, Linear webhook secret, App private key and webhook secret, Pushover app token and user key, `StartupError`. |
| `src/legacy-claims.ts` | Startup guard against an undrained `claims.json`. |
| `src/linear.ts`, `src/github.ts`, `src/github-app.ts`, `src/pushover.ts`, `src/git.ts`, `src/claude-transcript.ts`, `src/pause.ts` | The external services. |
| `src/linear-fixture.ts`, `src/github-app-fixture.ts`, `src/pushover-fake.ts`, `src/claude-transcript-fixture.ts`, `src/fixture-server.ts`, `src/github-fake.ts`, `src/test-harness.ts` | Test layers and the harness (see `development.md`). |
| `src/*.test.ts` | Tests beside the code. |
