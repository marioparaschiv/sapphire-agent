# Architecture

How the reconciler is put together: one tick, the rules and their order, the webhook server, the chat, the services, startup, and which module owns what.

## The reconciler

One level-triggered loop. There is no dispatcher and worker split, no message protocol and no in-memory run state. Each tick:

1. The `Observer` reads the outside world once: Linear, herdr, git (and nothing from the journal).
2. The `Planner` hands that observation to each rule in order. A rule reads the journal itself, decides what to do per epic, and returns at most one piece of work per epic (`EpicWork`). Work that is not about an epic (a command, a request whose epic has no run) is a `TaskWork`, named by a task such as `CMD-3`.
3. The planner runs that rule's work, each piece in its own fiber under the failure policy (`failure-policy.md`), waits for all of it, then moves on to the next rule.

Because every decision is made from what is observed now plus the journal, a missed herdr event, a crash or a restart never leaves state wrong: the next tick sees the same world and carries on. Every external write is idempotent (a marker check, a state check, or a write that is a no-op when already done), so doing a step again is safe.

The `Reconciler` service ticks at once on start, then every `pollSeconds`, and once more whenever `wake` is called. Wakes and polls that arrive during a tick collapse into one more tick. `main.ts` calls `wake` on every herdr event, so an agent status change is acted on within moments, while the poll always overrides what the socket said. It also calls `wake` whenever the file `wake` in the state directory is written, which `scripts/ctl.sh` does after recording a request, so a command's request is acted on at once. The webhook server calls `wake` once it queued a command, so a mention starts its command at once, and on every signed Linear delivery, so a change in Linear is acted on at once. Because of these wakes the poll is only a backstop, every 10 minutes by default; a Linear delivery missed while the service was down is covered by the tick at startup and the poll.

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
| 1 | requests | no | Acts on `ctl.sh stop` (ends the run, closes its tab), `ctl.sh send` (types into the agent) and `session` (a run's agent started another session); drops follow-up requests whose epic has no run. |
| 2 | cleanup | no | Ends what is left of finished runs (tab, worktree, branch, row), and resolves owned tabs and worktrees that no run tracks. |
| 3 | results | no | Ends runs whose epic moved on; reads, stores and posts result files; moves the epic to To Review. |
| 4 | monitoring | no | Tracks agent status and pane output; flags awaitingInput, stale, error and the wall-clock cap; nudges; asks on Linear what a run asked by message and got no reply to; relays replies. |
| 5 | follow-up | yes | Claims a follow-up run for a follow-up request, once the epic's run ended. |
| 6 | dispatch | yes | Claims ready epics up to `maxInFlight`. |
| 7 | start | no | Takes each claimed run through worktree, trust, tab, Claude and the move to Implementing. |
| 8 | topics | no | Gives each running epic a chat thread (a Telegram forum topic) named by its run's state, posts its PR there and in the main chat, its slices as they start and finish and its run's phases as they start, and sums it up in `✅ Done` and deletes it once it ships, or only deletes it once its run stops. |
| 9 | commands | no | Runs the command agents one at a time: starts the next, watches the running one, posts its replies as the GitHub App, ends it when it is done or fails it. |

Why this order: requests come first, so a stopped run is ended before any other rule looks at it. Cleanup and results end runs before monitoring looks at them, so one tick never flags a run it just ended. Claims come next, follow-ups before ready epics since both count against `maxInFlight`, so the start rule starts them in the same tick. Topics come after them, so a run dispatched this tick gets its thread at once and each thread shows what this tick left. Commands are not pausable: `resume` itself comes in as a command. Rules run one after another, so two rules never act on the same epic at once, and each sees in the journal what the rules before it wrote. A rule that takes over a tab checks herdr again first, since an earlier rule may have closed it this tick.

Pausing (`scripts/ctl.sh pause`) skips the pausable rules only: nothing new is claimed, but claimed runs still start, runs in flight are still watched, posted and cleaned up, and mentions still run commands. If the pause file cannot be read, the tick runs as paused.

Each rule details: `rules.md`.

## The webhook server

Mentions are not a rule: they arrive as GitHub App webhook deliveries. `WebhookServer` (`webhook-server.ts`) is an Effect-managed `node:http` server (`NodeHttpServer`) on `127.0.0.1:<bot.app.webhookPort>`, built as a layer beside the reconciler, so it listens while the service runs and closes on shutdown. nginx terminates TLS at `https://webhook.marioparaschiv.com/github` and forwards to it (`operations.md`). Linear's deliveries come to the same server on `/linear`, exposed by Tailscale Funnel (`operations.md`); each one's `Linear-Signature` is checked against the Linear webhook secret, and a signed one only wakes the reconciler, which reads Linear itself, so a duplicate or out-of-order delivery is harmless. On every other path, each GitHub delivery's signature is checked against the webhook secret, its payload is decoded with `Schema`, and a comment that mentions the bot is recorded as a command by `makeRecordMention` (`mentions.ts`, which holds the mention and allowed-user decisions), before the delivery is answered. See `rules.md` (Mentions).

GitHub does not redeliver a failed delivery by itself. `MissedDeliveries` (`missed-deliveries.ts`), forked by `main.ts` beside the reconciler, scans the App's delivery log at startup and every `deliveryScanSeconds` and asks GitHub to redeliver each event whose newest attempt failed, back to 10 minutes before the journal's delivery mark and at most 3 days. The redeliveries arrive at the webhook server like any other. A failed scan is logged and tried again on the next. See `rules.md` (Missed deliveries).

## The agent event server

`AgentEventServer` (`agent-event-server.ts`), a layer beside the webhook server, listens on `$STATE/events.sock` for the session events the coding agents' hooks send through `sapphire hook <agent>`. It decodes each with that agent's adapter, wakes the reconciler for a run's or command's pane, and records a `session` request when a run's agent started another session. See `rules.md` (Agent events).

## The chat

The user also talks to the service in a Telegram private chat with the bot, in threaded mode: the main chat is its General thread, and each running epic gets a forum topic. Core sees the chat only through the `Chat` port (`chat.ts`): a `Stream` of normalized `InboundMessage`s (`ref`, `conversation`, `text`, `replyTo`; the conversation is `main` or a `thread` core opened, by its ref), `send` for `Intent`s (`reply`, `epicState`, `pullRequestOpened`, `epicShipped`, `closeThread`, `sliceMoved`, `phaseStarted`, `question`; each but `reply` is safe to send again), `streamReply` (shows text as it streams in, keeps it once it ends or the user stops it), `openEpic` and `openArchive` (open a thread and return its ref). The adapter decides how they look. Epic topics and notifications go to the chat of the first id in `telegram.allowedUserIds` (the private chat id is the user's id).

`TelegramBot` (`telegram-bot.ts`) is the edge: an mtcute (`@mtcute/node`) MTProto client, logged in with the bot token, `api_id` and `api_hash` for the layer's lifetime, its new messages as a `Stream`, `sendText`, `sendOnce` (a send keyed by a `random_id` derived from what it is for, which Telegram refuses to repeat, so a send after a crash is not posted twice), `sendDraft` (`messages.setTyping` with `sendMessageTextDraftAction`, `canStop`), the stops of drafts as a `Stream` (`updateUserTyping` with `sendMessageStopDraftAction`: Telegram does not document how a stop reaches a bot, so this is unverified), `createTopic`, `editTopic`, `deleteTopic` (a topic id is the thread id of the service message, in the user's id space) and `download`. Updates arrive over its persistent connection. mtcute keeps its session and update state (pts, qts, date, seq) in `$HERDR_PLUGIN_STATE_DIR/telegram.session`, on `node:sqlite` through a small storage driver (mtcute's own needs the native better-sqlite3), and with `catchUp` fetches what was sent while the service was down. mtcute saves that state once it dispatched an update, not once it was handled, so a message received but not yet answered when the process dies is not handed over again; a crash before the state is saved can hand one over twice.

`telegramChat` (`telegram.ts`) is the only `Chat` adapter: it lets through each message an allowed user (`telegram.allowedUserIds`) writes in their private chat with the bot, in General or a topic, and drops and logs everything else (other users, group chats, messages without text or voice). A voice note is downloaded, decoded by `ffmpeg` to 16 kHz mono samples and transcribed in-process by `Transcriber` (`transcription.ts`, sherpa-onnx with Parakeet TDT 0.6B v3 int8); the bot answers it with the transcript (`🎙 <text>`) and passes the transcript on as the message's text, so core only sees text. A voice note it cannot transcribe gets a one-line answer naming the cause and goes no further. Topic names carry the state as an icon: `🟢` working, `⏸` awaiting input, `🔴` error (and stale), `👀` waiting for review. A streamed reply is a draft updated at most every 1.5 s (setTyping allows 20 calls in 5 s and 40 in 30 s per chat), kept as one message, or several past 4096 characters, once the text ends or the user presses stop.

`answerChatMessages` (`conversations.ts`) is core's side, forked by `main.ts` beside the reconciler. Each main-chat message is one turn of the user's own `claude` (`ClaudeChat`, `claude-chat.ts`: `claude -p --output-format stream-json --include-partial-messages --verbose`, with their settings, CLAUDE.md, hooks and MCP servers, in the home directory, the prompt on stdin), its text streamed back with `streamReply`; turns run concurrently. Context comes only from replies: every turn gets a new session id (`--session-id`); a reply to a bot message resumes that message's session forked (`--resume <id> --fork-session`), which leaves it as it was, so replying to an older message branches from exactly there; a message that replies to nothing starts a new session; a reply to a message whose session is unknown gets a one-line answer and no turn. Once a reply is kept, each of its messages is recorded with its session id (`chat_sessions`). Pressing stop interrupts the text stream, which kills Claude's process group, and keeps what was written. A failed turn ends the reply with why. `--append-system-prompt` (`Prompts.chat`) tells Claude it answers in the chat and names the `sapphire` subcommands, so asking it to start an epic runs `sapphire start <ID>` (without `--reply-to`). A message in an epic's thread (a voice note's transcript included) is recorded as a `send` request for its run, as `ctl.sh send` does, and wakes the reconciler, whose requests rule types it into the agent; with no run in flight and started, it gets a one-line answer and goes nowhere. A thread that belongs to no epic is logged and dropped. `keepChatSessionWarm`, forked beside it, resumes the newest bot message's session into a throwaway fork with the prompt `ping` every 55 minutes (`Schedule.fixed`, no idle cutoff), so its prompt cache stays warm, then deletes the fork's transcript.

## Services

Each is an Effect `Context.Service` with a live layer; the externals have a test layer.

| Service | Module | Does | Test layer |
| --- | --- | --- | --- |
| `AppConfig` | `config.ts` | Env, config file, API key, Linear webhook secret and the GitHub App's private key and webhook secret, read once at startup. | `AppConfig.layerTest(dir, settings)` |
| `Linear` | `linear.ts` | GraphQL over `HttpClient`: teams, epics, replies, comments, moves, labels, reactions. | `LinearFixture.layer`: a real HTTP server with the real `Linear` layer pointed at it. |
| `GitHub` | `github.ts` | `gh` CLI: PR lookup, summary, flags review, thread replies and resolves as the user; comments as the GitHub App. | `FakeGitHub.layer` |
| `GitHubApp` | `github-app.ts` | GitHub App auth over `HttpClient`: its `<slug>[bot]` login, read at startup, installation tokens, cached per installation, and the App's webhook delivery log: a page of it and a redelivery. | `GitHubAppFixture.layer`: a real HTTP server with the real `GitHubApp` layer pointed at it. |
| `Herdr` | `herdr.ts` | herdr CLI and event socket: workspaces, tabs (with extra shell variables), panes, agents, prompts, starting Claude (with extra arguments). | `FakeHerdr.layer` |
| `Git` | `git.ts` | Worktrees, pull, unsaved-work check, removal, origin's GitHub repo, the result file. | Real git in temp repos. |
| `ClaudeTrust` | `claude-trust.ts` | Pre-accepts Claude's folder trust in `~/.claude.json`. | Real temp files. |
| `ClaudeTranscript` | `claude-transcript.ts` | Reads a run's Claude session transcript in `~/.claude/projects` for a message it still waits on a reply to. | Real temp files, written by `claude-transcript-fixture.ts`. |
| `Journal` | `journal.ts` | SQLite journal of runs, transient failure streaks, commands and requests. | `Journal.layer(':memory:')` or a temp file. |
| `Pause` | `pause.ts` | Whether the pause file exists. | Real temp dir. |
| `Prompts` | `prompts.ts` | Tab labels and the orchestrate, follow-up and command prompts. | Pure. |
| `Comments` | `comments.ts` | Every Linear and PR comment body, each ending with its marker. | Pure. |
| `Observer` | `observation.ts` | One observation per tick. | Real, over the test layers. |
| `Planner` | `planner.ts` | Runs the rules under the failure policy. | Real. |
| `Reconciler` | `reconciler.ts` | The tick loop and `wake`. | Real. |
| `WebhookServer` | `webhook-server.ts` | GitHub App webhook deliveries in, commands recorded, the reconciler woken; Linear deliveries in, the reconciler woken; exposes the `url` it listens on. | Real, on port 0 (`makeHarness` builds it; `h.deliver` posts signed deliveries). |
| `AgentEventServer` | `agent-event-server.ts` | Agent session events in from `sapphire hook`, `session` requests recorded, the reconciler woken; exposes the socket `path`. | Real, on a socket in the harness's dir (`h.hook` runs the real `ctl.sh hook`). |
| `Chat` | `chat.ts` | The chat platform port: `inbound`, the messages of allowed users as a `Stream`; `send(intent)`, `streamReply`, `openEpic`, `openArchive`. Live: `telegramChat` (`telegram.ts`) over `TelegramBot` and `Transcriber`. | Real, over `FakeTelegram.bot` and `Transcriber.layerTest`. |
| `TelegramBot` | `telegram-bot.ts` | The bot's mtcute client: login at startup, new messages and draft stops as `Stream`s, sends, drafts, topics, downloads; session and update state in `telegram.session`. | `FakeTelegram.bot` |
| `Transcriber` | `transcription.ts` | A voice note to text: `ffmpeg` to 16 kHz mono float samples, then sherpa-onnx's offline recognizer, loaded once at startup. | Real (one test with the real model); `Transcriber.layerTest` reads the audio bytes as the transcript. |
| `ClaudeChat` | `claude-chat.ts` | The main chat's `claude -p` turns, as a `Stream` of text pieces, and the keep-alive. | Real, over `fakeClaude` (`claude-chat-fake.ts`), a fake process spawner. |
| `MissedDeliveries` | `missed-deliveries.ts` | `scan` redelivers failed webhook deliveries back to 10 minutes before the delivery mark; `run` scans at once and every `deliveryScanSeconds`. | Real, against `GitHubAppFixture` (`makeHarness` builds it; `h.scanDeliveries` runs one scan). |

Rules are not services: each rule module exports an Effect that builds its `Rule` (`name`, `pausable`, `plan`) from the services it needs, and `Planner.layer` takes them all. Shared run actions (flag an epic, close a run's tab, end a run, nudge an agent) live in `run-actions.ts`.

## Startup (`main.ts`)

1. `AppConfig.layer` reads env, the config file, the API key, the Linear webhook secret, the GitHub App's private key and webhook secret and the Telegram bot token, `api_id` and `api_hash` and reports every problem in one `StartupError` (one log line listing them all), then exits non-zero. See `config.md`.
2. `refuseUndrainedClaims` (`legacy-claims.ts`) stops startup while `$HERDR_PLUGIN_STATE_DIR/claims.json` of the old dispatcher still holds claims, and says to drain first (`operations.md`).
3. Only then are the services built: the journal opens `$HERDR_PLUGIN_STATE_DIR/journal.db` and runs its migrations, `GitHubApp` reads the App's slug from GitHub (`GET /app`), the webhook server starts listening (logging `listening for GitHub webhook deliveries on <url> and Linear ones on <url>/linear`), and so does the agent event server (`listening for agent events on <path>`), and `TelegramBot` logs in (logging `logged in to Telegram as @<username>`). A failure there, e.g. the port taken, stops startup.
4. Logs `watching <teams> every <n>s, at most <n> in flight`, forks a fiber that calls `wake` on every herdr event, one that calls it whenever the state directory's `wake` file is written, one that runs the delivery scan, one that answers chat messages (`answerChatMessages`) and one that keeps the chat session warm (`keepChatSessionWarm`), and runs the reconciler.

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
| `src/requests.ts` | Requests rule (stop, send, session). |
| `src/mentions.ts` | Records a comment that mentions the bot as a command (`makeRecordMention`). |
| `src/webhook-server.ts` | Webhook server: signature checks, payload schemas, recording mentions, waking the reconciler for mentions and Linear deliveries. |
| `src/agent-hook.ts` | `sapphire hook <agent>`: sends a hook payload to the agent event server. |
| `src/agent-event-server.ts` | Agent event server and the adapter per agent. |
| `src/agent-event.ts` | `AgentEvent`, agent-neutral, and the adapter type. |
| `src/claude-hooks.ts` | Claude Code's hook payloads to `AgentEvent`. |
| `src/chat.ts` | The chat platform port: `Chat`, `InboundMessage`, `Intent`. |
| `src/conversations.ts` | Core's answers to chat messages: a Claude turn per main-chat message, branching by reply, and the keep-alive. |
| `src/claude-chat.ts` | `ClaudeChat`: the main chat's `claude -p` turns and keep-alive. |
| `src/topics.ts` | Topics rule: each running epic's chat thread. |
| `src/transcription.ts` | `Transcriber`: voice notes to text. |
| `src/telegram.ts` | The Telegram adapter of `Chat`: the allowlist, voice notes, normalizing messages, rendering intents and topics, streaming replies. |
| `src/commands.ts` | Commands rule, the command agent's lockdown. |
| `src/cleanup.ts` | Cleanup rule and orphans. |
| `src/run-actions.ts` | Flag, close a run's tab, end a run, nudge. |
| `src/journal.ts` | Journal service, schema and migrations. |
| `src/markers.ts` | Marker format and parsing. |
| `src/comments.ts` | Comment texts. |
| `src/prompts.ts` | Tab label and prompts. |
| `src/result-file.ts` | Result file schema. |
| `src/call-policy.ts` | `Transient`, `Permanent`, timeouts and retries for every external call. |
| `src/config.ts` | Config schema, env, API key, Linear webhook secret, App private key and webhook secret, Telegram bot token, api_id and api_hash, `StartupError`. |
| `src/legacy-claims.ts` | Startup guard against an undrained `claims.json`. |
| `src/linear.ts`, `src/github.ts`, `src/github-app.ts`, `src/telegram-bot.ts`, `src/herdr.ts`, `src/git.ts`, `src/claude-trust.ts`, `src/claude-transcript.ts`, `src/pause.ts` | The external services. |
| `src/linear-fixture.ts`, `src/github-app-fixture.ts`, `src/telegram-fake.ts`, `src/claude-chat-fake.ts`, `src/claude-transcript-fixture.ts`, `src/fixture-server.ts`, `src/github-fake.ts`, `src/herdr-fake.ts`, `src/test-harness.ts` | Test layers and the harness (see `development.md`). |
| `src/fixtures/herdr/` | Real herdr JSON output and events, recorded from a named session, for the herdr tests. |
| `src/*.test.ts` | Tests beside the code. |
