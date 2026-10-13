# Development

How to change the code: commands, runtime, Effect conventions, the test harness, fakes and fixtures, style, running a dev instance safely, and commit rules.

## Commands

```sh
cd ~/sapphire-agent
npm test        # vitest run, every src/**/*.test.ts
npx tsc         # typecheck (also: npm run typecheck)
npm start       # node src/main.ts, the service itself; never against the live T3 server or real Linear
```

Run `npx tsc` and `npm test` before calling work done. There is no formatter or linter; match the style below.

## Runtime

- Node 24 runs `.ts` directly via type stripping. No build step, no output dir.
- `tsconfig.json`: `erasableSyntaxOnly`, `verbatimModuleSyntax`, `allowImportingTsExtensions`, `noEmit`. So: no enums, no namespaces, no parameter properties; `import type` for types; import with `.ts` extensions.
- ESM (`"type": "module"`).
- Dependencies: `effect` 4 (core: `http`, `process`, `socket`, `sql`, `testing`), `@effect/platform-node` (Node layers, `NodeRuntime`), `@effect/sql-sqlite-node` (the journal on `node:sqlite`). Dev: `vitest`, `@effect/vitest`, `typescript`, `@types/node`. Check the installed Effect d.ts files for the real Effect 4 API instead of assuming Effect 3 names.

## Conventions

- Effect-native everywhere: `Schema` for every external input (env, config, T3 replies, hook payloads, Linear responses, `gh` output, the result file, journal rows), `ChildProcess` for git and gh, `HttpClient` for T3, Linear, the GitHub App API and Pushover, `Socket` for the agent event server, `FileSystem` for files, `Config` for env, `Effect.log` with `annotateLogs`.
- Services are `Context.Service` classes with a static `layer` (and a test layer where useful). Types come from schemas (`typeof X.Type`), not hand-written copies.
- Every external call goes through `withCallPolicy` and fails only with `Transient` or `Permanent` (`failure-policy.md`). Don't swallow errors: handle them where that is the behaviour, otherwise let them reach the planner.
- Every external write must be idempotent: check its marker or its effect first (`journal-and-markers.md`). Order multi-step actions so a crash at any step is finished by the next tick.
- Store in the journal only what cannot be observed. A new concern is a new rule module exporting an Effect that builds its `Rule`, added to `rules.ts` in the right place.
- Time comes from `Clock`, so tests control it with `TestClock`.

## Tests

Tests sit beside the code as `src/*.test.ts` and use `@effect/vitest` (`it.effect` with `TestClock`; `it.live` only for tests that spawn a real process). Rules:

- `TestClock` for every timer. No real sleeps.
- Run real things where possible: SQLite (`':memory:'` or a temp file), temporary git repos, the Linear and GitHub App fixture servers, real files. Fake only `gh`, T3 and Pushover, as test layers.
- No tautological tests: drive realistic input through the code and assert the real output. Don't assert framework defaults or that a fake returned what it was told to.
- Crash safety: inject a failure at a write, run a fresh reconciler on the same journal and fixtures, and assert no double post and no skipped step.

### Fakes and fixtures

| Module | Provides | Controls |
| --- | --- | --- |
| `linear-fixture.ts` | `LinearFixture.layer`: a real HTTP server speaking Linear's GraphQL operations, plus the real `Linear` layer pointed at it. Seeded team `Test` with every workflow state. Also exports `postLinearDelivery` and `signLinearDelivery`, which send and sign a webhook delivery as Linear does. | Seed: `addEpic`, `addLabel`, `addComment(issueId, body)`. Edit as Linear records it in the issue's history, by the `owner` (default; the Linear service's own writes and a run's agent record the same) or an `automation` (with a `botActor`): `updateIssue(issueId, update, by?)` (title, description, state, labels, blockers, parent), `addSubIssue(epicId, identifier, title)`. The team also has a `Canceled` state. Inspect: `issue`, `stateName`, `labelNames`, `comments`, `mutations`. Inject: `failWrite`, `rateLimitWrite`, `crashAfterWrite` (applies the write, then drops the connection), `awaitAnswers`, `awaitCrash`. |
| `github-app-fixture.ts` | `GitHubAppFixture.layer`: a real HTTP server for the App endpoints (`/app`, `/repos/{owner}/{repo}/installation`, `/app/installations/{id}/access_tokens`), plus the real `GitHubApp` layer pointed at it. It answers 401 unless the JWT verifies against the public half of the configured App key (`AppConfig.layerTest` generates one), and times tokens by the JWT's `iat`, so they follow `TestClock`. Slug `orchestratorbot`. Also exports `postDelivery` and `signDelivery`, which send and sign a webhook delivery as GitHub does. | Seed: `install(repo)` (returns the installation id). Inspect: `url`, `jwts` (verified claims), `tokens` (minted, with installation and `expires_at`). Sync: `awaitAnswers(n)`, before `TestClock.adjust` while a call is in flight. |
| `t3-fake.ts` | `FakeT3.layer`: a `T3` in memory under the live call policy: projects, threads, runs, subagents, settling, and waits that return when the run ends or time out on `TestClock`. | Seed: `addProject`, `addSubagent`. Move on: `setRunStatus`, `setWorktreePath` (T3 made a launched thread's worktree), `addActivity` (a timeline item and `updatedAt`), `updateLastItem` (only the newest item changes), `setPendingRequests`, `setSettled` (the user or auto-settle). Inspect: `projects`, `thread`, `launches`, `sends`, `calls`. Inject: `rejectToken` (401), `hang`, `setLaunchOutcome` (refuse launches, or start their run in a status). |
| `src/fixtures/t3/*.json` | The `result` of T3 tool calls as recorded from the live server, which `t3.test.ts` serves from a local MCP endpoint (`serveFixture`, `fixture-server.ts`) to test the live `T3` layer. | Loaded by name with `recorded(name)`. |
| `summariser-fake.ts` | `FakeSummariser.layer`: a `Summariser` in memory that answers `The owner edited the epic.` | Inspect: `prompts()`. Inject: `answerWith(summary)`, or `answerWith(null)` to fail as `claude` exiting non-zero. |
| `pushover-fake.ts` | `FakePushover.layer`: a `Pushover` in memory. | Inspect: `sent()`. Inject: `failNext(times)` (Permanent, as for an invalid token). |
| `github-fake.ts` | `FakeGitHub.layer` (needs `GitHubApp`, for the App's login): a `GitHub` in memory, with the live layer's marker and cap rules. | `addPullRequest`, `addComment`, `addThread` (each returns what it made, with node id and url), `setPullRequestState`; inspect `comments`, `botComments`, `thread`, `hasThumbsUp`, `writes`; inject `crashAfterWrite`. Everything `GitHub` writes is authored by the App's `<slug>[bot]`; controls add comments by the PR's author unless given. |
| `claude-transcript-fixture.ts` | `transcriptEntries` (`prompt`, `toolCall(session, context)`) shaped as Claude Code 2.1 writes them, each assistant entry with its `usage`, `transcriptLines`, and `writeTranscript(directory, session, entries, agentId?)`, which writes the session's or its subagent's transcript where Claude Code does. | Used by the `ClaudeTranscript` and handoff tests. |

Inject fake crashes with a `Transient` error, so the epic's work stops without a failure comment. When a Linear write fails or crashes, the call policy waits on the clock before retrying: call `awaitAnswers` (or `awaitCrash`) before `TestClock.adjust`.

### Test harness (`test-harness.ts`)

`makeHarness(settings?)` (needs a `Scope`) wires the production rules, the `Projects` service (the test config's team `Test` imported as the only project) and the webhook server (on a free port) to real temp git repos (a bare origin whose path ends in `github.com/test/repo.git`, so `githubRepo` is `test/repo`, and a clone), the Linear and GitHub App fixtures, the GitHub, T3 and Pushover fakes and a SQLite journal file. It returns:

- `tick`, `pausedTick`: drive the planner as the service does.
- `deliver(delivery, signature?)`: POSTs a webhook delivery to the current webhook server, signed with the test secret (or the given `X-Hub-Signature-256`, `null` for none), and returns the HTTP status. `deliveries.issueComment`, `deliveries.reviewComment` and `deliveries.review` build GitHub-shaped deliveries for a fake's comment; `postDelivery` and `signDelivery` do the same for any server. `linearIssueMoved` is an Issue update payload as Linear sends it, for `postLinearDelivery`.
- `stop`: the first half of a restart, so deliveries fail as when the service is down.
- `restart`: a process restart. The planner, rules, webhook server and journal connection are built again on the same journal file, while Linear, GitHub, T3 and the repos keep their state.
- `crashAtJournalWrite(n)`, `crashed()`, `journalWrites()`: the nth journal write (runs, commands, requests, claims, notices and their sent marks, subagent handoffs, epic snapshots; not projects) of the reconciler or the webhook server from now dies before it is applied.
- `summariser`: the summary model fake (above).
- `pushover`: the Pushover fake: `sent()` (what reached Pushover), `failNext(times)` (the next sends fail Permanent).
- `t3`: the T3 fake (above).
- `threadRun(seed)`: a ready epic dispatched by a tick, its worktree made by T3 (`makeT3Worktree`) and recorded by another; the run is `running`. `writeTranscript(session, entries)`, `writeSubagentTranscript(session, agentId, entries)`: write a Claude session's, or its subagent's, transcript under the config's Claude directory.
- `ctl(...args)`: runs `src/ctl.ts` with `<args>` in process, as a command's agent would, through its own journal connection; returns the lines it printed or fails with its refusal. `hook(agent, payload)`: runs the real `ctl.sh hook` with the harness's directory as `SAPPHIRE_AGENT_CONFIG_DIR` and `SAPPHIRE_AGENT_STATE_DIR`, and returns its exit code, stdout and stderr. A run's events are known by the payload's `cwd`.
- `runs`, `commands`, `epicMarkers(issueId)` (the `<purpose>:<key>` of each marked comment, as `markerKeys` gives for any bodies), `notices(identifier)` (the epic's notices, oldest first: `<purpose>:<key>`, text, whether posted), `moveEpic`, `writeResultFile`, `worktrees()`, `hasBranch`, plus `git(cwd, ...args)` for test commits and pushes.

For lifecycle-style tests: advance `TestClock` before a follow-up claim (its summary marker is keyed by the claim time) and push the branch to origin first, so `pull --ff-only` works.

### The lifecycle test

`lifecycle.test.ts` runs one epic through everything on the harness: dispatch, T3 making the worktree, a question waiting in the agent's thread and answered there, results (`PR opened`, the summary and a flag as comments on the epic), a review thread that mentions the bot, delivered to the webhook (sent again after a crash failed it), whose command replies as the bot on the PR, asks for a follow-up and says it is done, the follow-up that replies to and resolves the thread and comments `Addressed your concerns inline.`, and cleanup once the PR is merged. Each step does what the user or agent does, then ticks until the reconciler got there. It first runs without a crash and asserts the end state, while counting the writes of each kind (journal, Linear, GitHub). Then it runs once per write with a crash injected at it, in an order shuffled by a seeded PRNG, restarting the reconciler right after the crash, and asserts the same end state and no double posts. Add a step there when a rule gains a write.

## Style

- Tabs, single quotes, semicolons, trailing commas, long lines OK. Match the surrounding file.
- Blank lines around guards, loops and before returns, as in existing code.
- Comments only for a non-obvious why. Docs and comments never cite line numbers.
- File names kebab-case.

## Running a dev instance safely

The live service uses the live T3 server, Linear, the GitHub App and the default directories. A dev run must not share any of them:

- Set `SAPPHIRE_AGENT_CONFIG_DIR` and `SAPPHIRE_AGENT_STATE_DIR` to separate temp dirs; without them a dev run uses the live ones.
- Point `t3.url` at a T3 server of its own (and `worktreesDirectory` at that server's worktrees); never make write calls to the live T3 server.
- Use a scratch Linear team or the fixture server, and a throwaway repo; a dev run against the real team claims real epics alongside the live service. Never run `gh` writes against real repos.
- Point `bot.app` at a scratch GitHub App installed only on the throwaway repo, so a dev run never posts as the live App, and set `bot.app.webhookPort` to a port other than the live service's 3790.

## Git

- Commit with the global git identity (signed commits are on by default). No AI attribution.
- Don't push.
