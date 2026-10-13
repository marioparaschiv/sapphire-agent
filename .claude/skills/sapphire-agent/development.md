# Development

## Commands

```sh
cd ~/sapphire-agent
npm test        # vitest run, every src/**/*.test.ts
npx tsc         # typecheck (also npm run typecheck)
npm start       # node src/main.ts; never against the live T3 server or real Linear
```

Both `npx tsc` and `npm test` must pass before work is done. No formatter or linter.

## Runtime

- Node 24 runs `.ts` via type stripping; no build, ESM (`"type": "module"`).
- `tsconfig.json`: `erasableSyntaxOnly`, `verbatimModuleSyntax`, `allowImportingTsExtensions`, `noEmit`: no enums, namespaces or parameter properties; `import type`; `.ts` import extensions.
- Deps: `effect` 4 (core `http`, `process`, `socket`, `sql`, `testing`), `@effect/platform-node` (Node layers, `NodeRuntime`), `@effect/sql-sqlite-node`. Dev: `vitest`, `@effect/vitest`, `typescript`, `@types/node`. Check the installed Effect d.ts files for the Effect 4 API; Effect 3 names differ.

## Conventions

- Effect-native: `Schema` for every external input (env, config, T3 replies, hook payloads, Linear, `gh` output, result file, journal rows); `ChildProcess` for git and gh; `HttpClient` for T3, Linear, GitHub App, Pushover; `Socket` for the agent event server; `FileSystem`; `Config` for env; `Effect.log` with `annotateLogs`; time from `Clock`.
- Services: `Context.Service` classes with a static `layer`. Types from schemas (`typeof X.Type`).
- External calls go through `withCallPolicy` and fail only with `Transient`/`Permanent` (`failure-policy.md`); handle a failure where that is the behaviour, else let it reach the planner.
- External writes are idempotent and crash-ordered; journal only what cannot be observed (`journal-and-markers.md`). A new concern is a new rule module exporting an Effect that builds its `Rule`, placed in `rules.ts` order.

## Style

Tabs, single quotes, semicolons, trailing commas, long lines OK; docs and comments never cite line numbers; kebab-case file names. Commits use the global git identity (signed by default).

## Tests

`src/*.test.ts` beside the code, `@effect/vitest`: `it.effect` with `TestClock`; `it.live` only to spawn a real process.

- `TestClock` for every timer, no real sleeps.
- Run real things: SQLite (`':memory:'` or temp file), temp git repos, the Linear and GitHub App fixture servers, real files. Fake only `gh`, T3 and Pushover.
- Crash safety: inject a failure at a write, run a fresh reconciler on the same journal and fixtures, assert no double post or skipped step (Lifecycle test). Inject crashes as `Transient`, so the work stops without a failure comment. A failed or crashed Linear write makes the call policy wait on the clock: `awaitAnswers` (or `awaitCrash`) before `TestClock.adjust`.

Test layers of the other services: `AppConfig.layerTest(dir, settings)` (generates an App key), `T3Config.layerTest`, `Layer.succeed(PushoverConfig, ...)`, `Journal.layer(':memory:')`; `Git`, `Pause`, `Projects`, `T3Projects`, `Prompts`, `Comments`, `Observer`, `Planner`, `Reconciler` real; `WebhookServer` on port 0; `AgentEventServer` on a socket in the harness dir.

### Fakes and fixtures

| Module | Provides | Controls |
| --- | --- | --- |
| `linear-fixture.ts` | `LinearFixture.layer`: real HTTP server speaking Linear's GraphQL, plus the real `Linear` layer. Team `Test` with every state; team `Ops` (`otherTeam`, not a project) whose issues can block epics. `postLinearDelivery`, `signLinearDelivery`. | Seed `addEpic` (`inverseRelations: [{ type: 'blocks', issueId }]`), `addLabel`, `addComment(issueId, body)`. Inspect `issue`, `stateName`, `labelNames`, `comments`, `mutations`. Inject `failWrite`, `rateLimitWrite`, `crashAfterWrite` (applies, then drops the connection), `awaitAnswers`, `awaitCrash`. |
| `github-app-fixture.ts` | `GitHubAppFixture.layer`: real HTTP server for `/app`, `/repos/{owner}/{repo}/installation`, `/app/installations/{id}/access_tokens`, plus the real `GitHubApp`. 401 unless the JWT verifies against the configured key; token times follow the JWT's `iat` (so `TestClock`). Slug `orchestratorbot`. `postDelivery`, `signDelivery`. | Seed `install(repo)` (returns the id). Inspect `url`, `jwts` (verified claims), `tokens` (with installation and `expires_at`). `awaitAnswers(n)` before `TestClock.adjust` while a call is in flight. |
| `t3-fake.ts` | `FakeT3.layer`: in-memory projects, threads, runs, subagents, settling, under the live call policy; waits return when the run ends or time out on `TestClock`. | Seed `addProject`, `addSubagent`. Move `setRunStatus`, `setWorktreePath` (T3 made the worktree), `addActivity` (timeline item and `updatedAt`), `updateLastItem` (only the newest changes), `setPendingRequests`, `setSettled` (user or auto-settle). Inspect `projects`, `thread`, `launches`, `sends`, `calls`. Inject `rejectToken` (401), `hang`, `setLaunchOutcome` (refuse launches, or start their run in a status). |
| `src/fixtures/t3/*.json` | Recorded `result`s of live T3 tool calls, served by `t3.test.ts` from a local MCP endpoint (`serveFixture`, `fixture-server.ts`) to test the live `T3`. | `recorded(name)`. |
| `pushover-fake.ts` | `FakePushover.layer`. | `sent()`, `failNext(times)` (Permanent). |
| `github-fake.ts` | `FakeGitHub.layer` (needs `GitHubApp` for the login), with the live layer's marker and cap rules; writes authored by `<slug>[bot]`, controls add comments as the PR's author unless given. | `addPullRequest`, `addComment`, `addThread` (return node id and url), `setPullRequestState`; inspect `comments`, `botComments`, `thread`, `hasThumbsUp`, `writes`; `crashAfterWrite`. |
| `claude-transcript-fixture.ts` | `transcriptEntries` (`prompt`, `toolCall(session, context)`) as Claude Code 2.1 writes them, with `usage`; `transcriptLines`; `writeTranscript(directory, session, entries, agentId?)`. | For `ClaudeTranscript` and handoff tests. |

### Harness (`test-harness.ts`)

`makeHarness(settings?)` (needs a `Scope`) wires the production rules, `Projects` (team `Test` imported) and the webhook server (free port) to temp git repos (a bare origin ending `github.com/test/repo.git`, so `githubRepo` is `test/repo`, and a clone), the fixtures, the fakes and a SQLite journal file. It returns:

- `tick`, `pausedTick`.
- `deliver(delivery, signature?)`: POSTs a delivery signed with the test secret (or the given `X-Hub-Signature-256`, `null` for none), returns the status. `deliveries.issueComment|reviewComment|review` build GitHub-shaped deliveries; `linearIssueMoved` is a Linear Issue update for `postLinearDelivery`.
- `stop` (first half of a restart; deliveries fail), `restart` (rebuilds planner, rules, servers and journal connection on the same file; Linear, GitHub, T3, repos keep state).
- `crashAtJournalWrite(n)`, `crashed()`, `journalWrites()`: the nth journal write of the reconciler or webhook server from now (runs, commands, requests, claims, notices and sent marks, subagent handoffs; not projects) dies before applying.
- `pushover`, `t3`: the fakes.
- `threadRun(seed)`: a ready epic dispatched, its worktree made by T3 (`makeT3Worktree`) and recorded; `running`. `writeTranscript(session, entries)`, `writeSubagentTranscript(session, agentId, entries)` under the config's Claude directory.
- `ctl(...args)`: runs `src/ctl.ts` in process with its own journal connection; returns printed lines or fails with the refusal. `hook(agent, payload)`: runs the real `ctl.sh hook` with the harness dir as both env dirs; returns exit code, stdout, stderr.
- `runs`, `commands`, `epicMarkers(issueId)` (`<purpose>:<key>`, as `markerKeys` gives), `notices(identifier)` (oldest first: `<purpose>:<key>`, text, posted), `moveEpic`, `writeResultFile`, `worktrees()`, `hasBranch`, `git(cwd, ...args)`.

Before a follow-up claim, advance `TestClock` (its summary marker is keyed by claim time) and push the branch so `pull --ff-only` works.

### Lifecycle test

`lifecycle.test.ts` takes one epic through the whole flow (`overview.md`) on the harness, from T3 making the worktree to cleanup after merge, including a question answered in the thread and a mention delivery re-sent after a crash failed it; each step acts as user or agent, then ticks until the reconciler gets there. It runs once crash-free counting writes per kind (journal, Linear, GitHub), then once per write with a crash injected there, in an order shuffled by a seeded PRNG, restarting right after, asserting the same end state and no double posts. Add a step when a rule gains a write.

## Dev instance

A dev run must share nothing with the live service:

- Separate temp `SAPPHIRE_AGENT_CONFIG_DIR` and `SAPPHIRE_AGENT_STATE_DIR`.
- Its own T3 server in `t3.url` (and `worktreesDirectory`); no writes to the live T3 server.
- A scratch Linear team or the fixture, and a throwaway repo (the real team means claiming real epics); no `gh` writes to real repos.
- A scratch GitHub App in `bot.app`, installed only on the throwaway repo, and a `bot.app.webhookPort` other than 3790.
