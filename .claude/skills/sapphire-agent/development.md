# Development

How to change the code: commands, runtime, Effect conventions, the test harness, fakes and fixtures, style, testing against herdr safely, and commit rules.

## Commands

```sh
cd ~/sapphire-agent
npm test        # vitest run, every src/**/*.test.ts
npx tsc         # typecheck (also: npm run typecheck)
npm start       # node src/main.ts, the service itself; never against the live herdr session or real Linear
```

Run `npx tsc` and `npm test` before calling work done. There is no formatter or linter; match the style below.

## Runtime

- Node 24 runs `.ts` directly via type stripping. No build step, no output dir.
- `tsconfig.json`: `erasableSyntaxOnly`, `verbatimModuleSyntax`, `allowImportingTsExtensions`, `noEmit`. So: no enums, no namespaces, no parameter properties; `import type` for types; import with `.ts` extensions.
- ESM (`"type": "module"`).
- Dependencies: `effect` 4 (core: `http`, `process`, `socket`, `sql`, `testing`), `@effect/platform-node` (Node layers, `NodeRuntime`), `@effect/sql-sqlite-node` (the journal on `node:sqlite`). Dev: `vitest`, `@effect/vitest`, `typescript`, `@types/node`. Check the installed Effect d.ts files for the real Effect 4 API instead of assuming Effect 3 names.

## Conventions

- Effect-native everywhere: `Schema` for every external input (env, config, `~/.claude.json`, herdr output and events, Linear responses, `gh` output, the result file, journal rows), `ChildProcess` for herdr, git and gh, `HttpClient` for Linear, mtcute (`@mtcute/node`) for Telegram, wrapped with `Effect.tryPromise` in `TelegramBot`, `Socket` as a `Stream` for herdr events, `FileSystem` for files, `Config` for env, `Effect.log` with `annotateLogs`.
- Services are `Context.Service` classes with a static `layer` (and a test layer where useful). Types come from schemas (`typeof X.Type`), not hand-written copies.
- Every external call goes through `withCallPolicy` and fails only with `Transient` or `Permanent` (`failure-policy.md`). Don't swallow errors: handle them where that is the behaviour, otherwise let them reach the planner.
- Every external write must be idempotent: check its marker or its effect first (`journal-and-markers.md`). Order multi-step actions so a crash at any step is finished by the next tick.
- Store in the journal only what cannot be observed. A new concern is a new rule module exporting an Effect that builds its `Rule`, added to `rules.ts` in the right place.
- Time comes from `Clock`, so tests control it with `TestClock`.

## Tests

Tests sit beside the code as `src/*.test.ts` and use `@effect/vitest` (`it.effect` with `TestClock`; `it.live` only for tests that spawn a real process). Rules:

- `TestClock` for every timer. No real sleeps.
- Run real things where possible: SQLite (`':memory:'` or a temp file), temporary git repos, the Linear and GitHub App fixture servers, real files. Fake only `gh`, herdr, the Telegram bot client, project topics' `claude` and the manager's Agent SDK `query` and `getSessionInfo`, as test layers.
- No tautological tests: drive realistic input through the code and assert the real output. Don't assert framework defaults or that a fake returned what it was told to.
- Crash safety: inject a failure at a write, run a fresh reconciler on the same journal and fixtures, and assert no double post and no skipped step.

### Fakes and fixtures

| Module | Provides | Controls |
| --- | --- | --- |
| `linear-fixture.ts` | `LinearFixture.layer`: a real HTTP server speaking Linear's GraphQL operations, plus the real `Linear` layer pointed at it. Seeded team `Test` with every workflow state. Also exports `postLinearDelivery` and `signLinearDelivery`, which send and sign a webhook delivery as Linear does. | Seed: `addEpic`, `addLabel`, `addComment(issueId, body)`. Inspect: `issue`, `stateName`, `labelNames`, `comments`, `mutations`. Inject: `failWrite`, `rateLimitWrite`, `crashAfterWrite` (applies the write, then drops the connection), `awaitAnswers`, `awaitCrash`. |
| `github-app-fixture.ts` | `GitHubAppFixture.layer`: a real HTTP server for the App endpoints (`/app`, `/repos/{owner}/{repo}/installation`, `/app/installations/{id}/access_tokens`, `/app/hook/deliveries` with `per_page`, `cursor` and a `Link` header, `/app/hook/deliveries/{id}/attempts`), plus the real `GitHubApp` layer pointed at it. It answers 401 unless the JWT verifies against the public half of the configured App key (`AppConfig.layerTest` generates one), and times tokens and redeliveries by the JWT's `iat`, so they follow `TestClock`. Like GitHub, it sends deliveries, signed with the webhook secret, to a webhook URL and logs each attempt; a redelivery POSTs the stored payload again with the same `guid` before answering 202. Slug `orchestratorbot`. Also exports `postDelivery` and `signDelivery`. | Seed: `install(repo)` (returns the installation id), `setWebhookUrl`, `deliver(delivery)` (sends it; 502 when nothing listens, as nginx answers), `addDelivery(delivery, statusCode, guid?)` (logs an attempt without sending), `addSlowDelivery(delivery, statusCode)` (the same, listed only once its `list` runs, after newer attempts). Inspect: `url`, `jwts` (verified claims), `tokens` (minted, with installation and `expires_at`), `deliveries` (the log, newest first), `redelivered` (ids), `deliveryPages` (cursors asked for). Inject: `refuseRedelivery(id, times)` (422), `refuseDeliveryPages(times)` (403). Sync: `awaitAnswers(n)`, before `TestClock.adjust` while a call is in flight. |
| `telegram-fake.ts` | `FakeTelegram.layer`: Telegram in memory, as the bot's client sees it; `FakeTelegram.bot`: a `TelegramBot` connected to it while the layer lives (build it again for a restart). Like mtcute, a connected bot gets each message at once and its stored update state moves past a message once dispatched; a bot that connects again catches up on what was written while it was down. Like Telegram, it refuses a send to a chat the user never wrote in or to a deleted topic, and a send keyed by a used `random_id` does nothing. | Seed: `write({ from, text?, voice?, groupChatId?, topicId?, replyTo? })` (a user's message or voice note in their private chat with the bot, or in a group or topic; returns its message id), `stopDraft` (the user presses stop on the newest draft), `deleteTopic(topicId)` (the user deletes a topic). Inspect: `sent` (text and its `entities`), `drafts`, `topics()`, `topicsCreated()`, `writes()`. Sync: `awaitSent(n)`, `awaitDrafts(n)`. Inject: `crashAfterWrite`. |
| `claude-chat-fake.ts` | `fakeClaude(claudeConfigDirectory, answer)`: a process spawner that stands in for `claude`, printing stream-json as Claude Code 2.1 does, starting with the recorded `system/init` event (`fixtures/claude/system-init.json`, `recordedInit`), and writing each session's transcript where Claude Code does. A run that hangs is killed when its scope closes, as the live spawner kills the process group. | `answer(run)` returns its `text`, `afterToolCall`, `hang`, `failure`, `exitCode`, `stderr`. Inspect: `runs` (args, cwd, prompt, `killed`). Sync: `awaitRuns(n)`. Provide its `layer` instead of `NodeServices` (whose spawner would start the real `claude`). |
| `claude-agent-fake.ts` | `fakeClaudeAgent(answer?)`: the Agent SDK's `query` and `getSessionInfo` as the manager calls them (a `ClaudeAgent` layer), without Claude. Each session reads its prompt input by input as they come, as the SDK does, and reaches the manager's in-process MCP server through a real MCP client. A session has a transcript once it read an input or said something, which `getSessionInfo` finds with its last change; resuming a session without one fails at once, as Claude Code does. | `answer(text)` returns `send_message` arguments for an input, or null. Inspect: `sessions` (id, options, inputs with text and priority, `closed`). Drive: `callTool(name, args)`, `say(text)` (plain assistant text), `endTurn(context?)` (an assistant message whose usage is `{ input, cacheRead, cacheCreation }`, then the turn's `result`), `crash(message)` (on the newest session), `forget(sessionId)` (its transcript is gone, as after Claude Code's cleanup). Sync: `awaitSessions(n)`, `awaitInputs(n)`, `awaitClosed(n)`. |
| `github-fake.ts` | `FakeGitHub.layer` (needs `GitHubApp`, for the App's login): a `GitHub` in memory, with the live layer's marker and cap rules. | `addPullRequest`, `addComment`, `addThread` (each returns what it made, with node id and url), `setPullRequestState`; inspect `comments`, `botComments`, `thread`, `hasThumbsUp`, `writes`; inject `crashAfterWrite`. Everything `GitHub` writes is authored by the App's `<slug>[bot]`; controls add comments by the PR's author unless given. |
| `herdr-fake.ts` | `FakeHerdr.layer`: a `Herdr` in memory, with the live layer's tab and ownership logic and an event stream. | `addTab`, `setAgentStatus`, `setAgent`, `setTail`, `removeTab`, `setStartBehaviour`; inspect `tabs` (with the cwd and variables each was opened with), `starts` (with the arguments), `prompts`, `sentKeys`, `closedTabs`, `writes`; `emit` (a state change without `emit` is a dropped event), `disconnect`, `awaitConnections`; inject `failWrite`, `crashAfterWrite`. |
| `claude-transcript-fixture.ts` | `transcriptEntries` (prompt, text, `toolCall(session, context)`, `sentMessage`, `peerMessage`, `taskNotification`) shaped as Claude Code 2.1 writes them, each assistant entry with its `usage`, `transcriptLines`, and `writeTranscript(directory, session, entries, agentId?)`, which writes the session's or its subagent's transcript where Claude Code does. | Used by the `ClaudeTranscript`, monitoring and handoff tests. |
| `fixtures/herdr/` | Real herdr JSON output and socket events, recorded from a named session. | Used by the herdr service tests, through a fake process spawner that answers each herdr command with them. |
| `fixtures/claude/system-init.json` | A real `system/init` event of a chat turn, recorded with the user's settings. | Printed by `fakeClaude`; used by the settings check tests. |

Inject fake crashes with a `Transient` error, so the epic's work stops without a failure comment. When a Linear write fails or crashes, the call policy waits on the clock before retrying: call `awaitAnswers` (or `awaitCrash`) before `TestClock.adjust`.

### Test harness (`test-harness.ts`)

`makeHarness(settings?, { answerChat? })` (needs a `Scope`) wires the production rules, the `Projects` service (the test config's team `Test` imported as the only project) and the webhook server (on a free port) to real temp git repos (a bare origin whose path ends in `github.com/test/repo.git`, so `githubRepo` is `test/repo`, and a clone), a temp `claude.json`, the Linear and GitHub App fixtures, the GitHub and herdr fakes and a SQLite journal file. It returns:

- `tick`, `pausedTick`: drive the planner as the service does.
- `deliver(delivery, signature?)`: POSTs a webhook delivery to the current webhook server, signed with the test secret (or the given `X-Hub-Signature-256`, `null` for none), and returns the HTTP status. `deliveries.issueComment`, `deliveries.reviewComment` and `deliveries.review` build GitHub-shaped deliveries for a fake's comment; `postDelivery` and `signDelivery` do the same for any server. `linearIssueMoved` is an Issue update payload as Linear sends it, for `postLinearDelivery`.
- `app`: the `GitHubAppFixture`, pointed at the current webhook server. `stop`: the first half of a restart, so deliveries `app.deliver` sends fail as when the service is down. `scanDeliveries`: one scan of the current `MissedDeliveries`.
- `restart`: a process restart. The planner, rules, webhook server, delivery scan and journal connection are built again on the same journal file, while Linear, GitHub, herdr and the repos keep their state.
- `crashAtJournalWrite(n)`, `crashed()`, `journalWrites()`, `awaitJournalWrites(n)`: the nth journal write (runs, commands, requests, claims, the delivery mark, topics, chat sessions, notices and their sent marks, subagent handoffs; not projects) of the reconciler, the webhook server, the delivery scan or the chat from now dies before it is applied; wait for a write made outside a tick, e.g. the chat recording a message.
- `telegram`, `telegramUser`: the Telegram fake behind the rules' `Chat` (with `Transcriber.layerTest`), and the first allowed user, who must `write` to the bot before it can write to them. With `answerChat`, `answerChatMessages` and the manager run in every build (main-chat messages answered `OK.` by the manager over `fakeClaudeAgent`, project-topic turns by a fake `claude`), so messages in a topic reach the run. `manager`: that `fakeClaudeAgent`'s controls, e.g. to see the agent event lines it got.
- `startedRun(seed)`: an epic in Implementing with a real worktree, a tab running Claude and a `running` row (with `replyTo` if the seed has one). `writeTranscript(session, entries)`, `writeSubagentTranscript(session, agentId, entries)`: write a Claude session's, or its subagent's, transcript under the config's Claude directory.
- `ctl(...args)`: runs `ctl.sh <args>` in process, as a command's agent would, through its own journal connection; returns the lines it printed or fails with its refusal. `hook(agent, payload, paneId)`: runs the real `ctl.sh hook` and returns its exit code, stdout and stderr.
- `runs`, `commands`, `epicMarkers(issueId)` (the `<purpose>:<key>` of each marked comment, as `markerKeys` gives for any bodies), `notices(identifier)` (the epic's or command's notices, oldest first: `<purpose>:<key>`, text, whether sent), `moveEpic`, `renameTab`, `writeResultFile`, `worktrees()`, `hasBranch`, plus `git(cwd, ...args)` for test commits and pushes.

For lifecycle-style tests: advance `TestClock` before a follow-up claim (its summary marker is keyed by the claim time) and push the branch to origin first, so `pull --ff-only` works.

### The lifecycle test

`lifecycle.test.ts` runs one epic through everything on the harness: dispatch, the project's topic, a slice started and done and `/sreview` (a `PostToolUse` hook) posted in its topic, a question asked there and answered by a message in the topic, results (`PR opened` on the epic, the summary and a flag as notices), a review thread that mentions the bot, delivered to the webhook (redelivered after a crash failed it), whose command replies in the chat, asks for a follow-up and says it is done, the follow-up that replies to and resolves the thread and comments `Addressed your concerns inline.`, cleanup once the PR is merged, and the epic shipped, its topic summed up in `✅ Done` and deleted. Each step does what the user or agent does, then ticks until the reconciler got there. It first runs without a crash and asserts the end state, while counting the writes of each kind (journal, Linear, GitHub, herdr, Telegram). Then it runs once per write with a crash injected at it, in an order shuffled by a seeded PRNG, restarting the reconciler right after the crash, and asserts the same end state (Telegram messages in any order) and no double posts, but for the known exceptions it names (an answer typed again, a stray topic). A hook or a topic message the crash failed is sent again once the service is back. Add a step there when a rule gains a write.

## Style

- Tabs, single quotes, semicolons, trailing commas, long lines OK. Match the surrounding file.
- Blank lines around guards, loops and before returns, as in existing code.
- Comments only for a non-obvious why. Docs and comments never cite line numbers.
- File names kebab-case.

## Testing against herdr safely

The live service and your interactive herdr both use the default session (`~/.config/herdr/herdr.sock`). Never stop or restart it, and never run `herdr server stop` without `--session`.

Use a named session:

```sh
herdr --session hl-test server                 # headless server for the test session
herdr --session hl-test status server          # socket: ~/.config/herdr/sessions/hl-test/herdr.sock
HERDR_SOCKET_PATH=~/.config/herdr/sessions/hl-test/herdr.sock herdr workspace list
```

- Point a dev run at it with `HERDR_SOCKET_PATH=~/.config/herdr/sessions/hl-test/herdr.sock`. The herdr CLI honours this env var and the service passes it on, so both CLI calls and the event socket hit the test session.
- `HERDR_SESSION=<name>` in the env is not enough: CLI commands ignore it and talk to the default session.
- Use separate temp dirs for `HERDR_PLUGIN_CONFIG_DIR` and `HERDR_PLUGIN_STATE_DIR`. Set `worktreesDirectory` in that config and `CLAUDE_CONFIG_PATH` to a copy, or the dev run writes the real `~/.herdr/worktrees` and `~/.claude.json`.
- Use a scratch Linear team or the fixture server, and a throwaway repo; a dev run against the real team claims real epics alongside the live service. Never run `gh` writes against real repos.
- Point `bot.app` at a scratch GitHub App installed only on the throwaway repo, so a dev run never posts as the live App, and set `bot.app.webhookPort` to a port other than the live service's 3790.
- Clean up with `herdr --session hl-test server stop` (only that session).

## Git

- Commit with the global git identity (signed commits are on by default). No AI attribution.
- Don't push.
