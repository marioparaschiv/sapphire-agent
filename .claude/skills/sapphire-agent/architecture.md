# Architecture

## The reconciler

One level-triggered loop: no dispatcher/worker split, no message protocol, no in-memory run state. Each tick:

1. `Observer` reads Linear, git and the runs' T3 threads once (from the journal, only which runs exist).
2. `Planner` hands the observation to each rule in order (`rules.md`). A rule reads the journal itself and returns at most one piece of work per epic (`EpicWork`); work not about an epic (a command, a request whose epic has no run) is `TaskWork`, named by a task such as `CMD-3`.
3. Each piece runs in its own fiber under the failure policy (`failure-policy.md`); the planner waits for all of it before the next rule.

Decisions come only from what is observed now plus the journal, and every external write is idempotent, so a missed wake, crash or restart never leaves state wrong.

### Wakes

`Reconciler` ticks at start, every `pollSeconds` (a backstop, 10 min by default), and on `wake`; wakes and polls during a tick collapse into one more tick. `wake` is called by:

- `main.ts`, whenever `$STATE/wake` is written (the CLI does after every request, pause or resume);
- the webhook server, after queuing a command and on every signed Linear delivery (a Linear delivery missed while down is covered by the startup tick and the poll);
- the agent event server (`rules.md`, Agent events);
- `watchThreads` (`thread-waits.ts`): one `t3_thread_wait` (4 min, reopened when it only timed out) per T3 run in flight and per command claimed or running, read from the journal every 5 s; it wakes once a wait returns, so a finished, failed or interrupted run is acted on within seconds. Reopened after a restart;
- `wakeForEpicEdits` (`epic-edits.ts`), when a run's epic edits have waited their debounce window (`rules.md`, Epic edits);
- `Projects.changes`, so a project added or removed is observed next tick.

## The observation

| Field | What |
| --- | --- |
| `teams` | The projects' teams with every configured state, by team id. A team missing or lacking a state is left out; its epics are not touched. |
| `epics` | Every epic the journal has a run of, every ready epic, and the epics named by worktree branches. |
| `ready` | Top-level epics in a ready state, at most 50. |
| `worktrees` | Every worktree under the worktrees directory of a project's or run's repo. |
| `threads` | The thread of every run not over (`t3_thread_read`, its newest 5 timeline items, `t3_thread_list` of its project's unsettled threads for its subagents): status, title, worktree, pending requests, last progress. A thread T3 no longer has is left out; one T3 could not be asked about is `unknown`, which counts as working. |

## Modules

Services are Effect `Context.Service`s with a live layer (test layers: `development.md`). Rules are not services: each rule module exports an Effect building its `Rule` (`name`, `pausable`, `plan`); `Planner.layer` takes them all.

- `config.ts`: `AppConfig` (env, config, Linear key, Linear webhook secret, App key and webhook secret; read once at startup), `PushoverConfig` (service only, same pass: `PushoverConfig.layerWithAppConfig`), `T3Config` (`t3.url`, token and its `exp`; service and CLI), `StartupError`.
- `t3.ts` `T3`, `linear.ts` `Linear`, `github.ts` `GitHub`, `github-app.ts` `GitHubApp`, `git.ts` `Git`: `integrations.md`. `t3.ts` also has `T3Unauthorized`, `T3ToolFailure`, `t3Policy`.
- `t3-projects.ts` `T3Projects.projectFor(repo)`: T3 project id of a team or label repo from the journal, else T3's project with that workspace root, else a new one; remembered, one lookup at a time.
- `claude-transcript.ts` `ClaudeTranscript.contextTokens`: context of a run's Claude session or subagent from its transcript in `~/.claude/projects`, reading only what was appended since the last call.
- `journal.ts` `Journal` (`journal-and-markers.md`); `markers.ts` marker format and parsing.
- `projects.ts` `Projects` (and `projectInRepo`): projects from the journal, in memory; `list`, `get`, `put`, `remove`, `changes`; their only writer.
- `pause.ts` `Pause`: `path`, exists, `pause`/`resume` create/remove the file.
- `prompts.ts` `Prompts`: thread titles; orchestrate, follow-up, command, handoff prompts. `comments.ts` `Comments`: every notice and comment body with its marker. Both pure.
- `observation.ts` `Observer`, plus helpers shared by rules (roles, in-flight statuses, whether a run's agent works). `planner.ts` `Planner`: `Rule`, `EpicWork`, epic-level failure policy, observing outage. `reconciler.ts` `Reconciler`: tick loop, `wake`, pause logging, pause-file outage, T3 token check.
- `webhook-server.ts` `WebhookServer`: Effect-managed `node:http` (`NodeHttpServer`) on `127.0.0.1:<bot.app.webhookPort>`, a layer beside the reconciler (closes on shutdown), exposing its `url`; `mentions.ts` `makeRecordMention`, the mention and allowed-user decisions (`rules.md`, Webhook deliveries). `agent-event-server.ts` `AgentEventServer` and its `adapters`: `$STATE/events.sock`, exposing its `path` (`rules.md`, Agent events).
- `summariser.ts` `Summariser.summarise(prompt)`: `claude -p --model <summaryModel>` with the prompt on stdin, no tools, no saved session and no user settings or MCP servers (so the run hooks never see it); one attempt with a 60 s timeout; Permanent on a non-zero exit.
- `pushover.ts` `Pushover.send`; `outages.ts` `makeOutage` (`failure-policy.md`, Outages).
- `rules.ts`: every rule in order, each in its own module: `requests.ts`, `cleanup.ts` (and orphans), `results.ts` (and posting), `monitoring.ts`, `handoffs.ts` (and `makeContextCheck`, doc paths), `follow-up.ts`, `dispatch.ts` (dispatch and start, repo resolution, claims), `epic-edits.ts` (and `wakeForEpicEdits`), `commands.ts`, `notices.ts`. `run-actions.ts`: flag, end a run, interrupt/settle/send to a run's or command's thread.
- `agent-hook.ts`: `sapphire hook <agent>` and `sendEvent`; Claude's `PreToolUse` also runs `run-hooks.ts` (guards in `run-guards.ts`, shell parsing in `shell-words.ts`, with `commandToolDecision` and `isCommandCwd` for command threads). `agent-event.ts` `AgentEvent`, `AgentName` and adapter type; `claude-hooks.ts` Claude's adapter; `pi-hooks.ts` Pi's adapter and tool mapping; `pi-extension.ts` the Pi extension (events, guards, its T3 thread via `T3.currentThread` and `T3Config.layerForAgent`); `agent-activity.ts` `AgentActivity` (last hook event per run's agent and subagents, in memory).
- `t3-settings.ts`: `t3SettingsProblems`, `checkT3Settings`, `defaultModelSelection` (passed to every launch).
- `main.ts` entry point; `ctl.ts` CLI (Effect `cli`, `operations.md`); `directories.ts` default dirs, commands dir, `ctl.sh` path, handoff doc path (node built-ins only, for the hook); `result-file.ts` `ResultFile`; `call-policy.ts`; `legacy-claims.ts` the `claims.json` guard.
- Tests: `*-fixture.ts`, `*-fake.ts` (`t3-fake.ts` also `t3TokenExpiring`), `fixture-server.ts`, `test-harness.ts`, `*.test.ts` (`development.md`).

## Startup (`main.ts`)

1. `PushoverConfig.layerWithAppConfig` reads env, config, every secret file; all problems become one `StartupError` and a non-zero exit (`config.md`).
2. `refuseUndrainedClaims` stops while `$STATE/claims.json` still holds claims (`operations.md`, Cutover from the old dispatcher).
3. Services are built: journal opens `$STATE/journal.db` and migrates; `Projects` loads (importing config `teams` into an empty table, warning while `teams` remains); `GitHubApp` reads its slug (`GET /app`); `T3Config` reads the token (its own `StartupError`); servers log `listening for GitHub webhook deliveries on <url> and Linear ones on <url>/linear` and `listening for agent events on <path>`. A failure (e.g. port taken) stops startup.
4. `checkT3Settings` reads `t3.settingsFile` and tells Pushover once if T3 would remove the projects' worktrees or not settle merged threads (`operations.md`, T3 settings).
5. Logs `watching <projects> every <n>s, at most <n> in flight` (`no projects`), forks fibers running `watchThreads`, running `wakeForEpicEdits`, calling it again on every project change, and calling `wake` when the `wake` file is written, runs the reconciler.

`NodeRuntime.runMain` runs it; SIGTERM interrupts the tick cleanly. Logs go to stdout with `epic` and `rule` annotations.
