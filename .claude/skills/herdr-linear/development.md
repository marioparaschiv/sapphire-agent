# Development

How to change the code: commands, runtime, Effect conventions, the test harness, fakes and fixtures, style, testing against herdr safely, and commit rules.

## Commands

```sh
cd ~/herdr-linear
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

- Effect-native everywhere: `Schema` for every external input (env, config, `~/.claude.json`, herdr output and events, Linear responses, `gh` output, the result file, journal rows), `ChildProcess` for herdr, git and gh, `HttpClient` for Linear, `Socket` as a `Stream` for herdr events, `FileSystem` for files, `Config` for env, `Effect.log` with `annotateLogs`.
- Services are `Context.Service` classes with a static `layer` (and a test layer where useful). Types come from schemas (`typeof X.Type`), not hand-written copies.
- Every external call goes through `withCallPolicy` and fails only with `Transient` or `Permanent` (`failure-policy.md`). Don't swallow errors: handle them where that is the behaviour, otherwise let them reach the planner.
- Every external write must be idempotent: check its marker or its effect first (`journal-and-markers.md`). Order multi-step actions so a crash at any step is finished by the next tick.
- Store in the journal only what cannot be observed. A new concern is a new rule module exporting an Effect that builds its `Rule`, added to `rules.ts` in the right place.
- Time comes from `Clock`, so tests control it with `TestClock`.

## Tests

Tests sit beside the code as `src/*.test.ts` and use `@effect/vitest` (`it.effect` with `TestClock`; `it.live` only for tests that spawn a real process). Rules:

- `TestClock` for every timer. No real sleeps.
- Run real things where possible: SQLite (`':memory:'` or a temp file), temporary git repos, the Linear fixture server, real files. Fake only `gh` and herdr, as test layers.
- No tautological tests: drive realistic input through the code and assert the real output. Don't assert framework defaults or that a fake returned what it was told to.
- Crash safety: inject a failure at a write, run a fresh reconciler on the same journal and fixtures, and assert no double post and no skipped step.

### Fakes and fixtures

| Module | Provides | Controls |
| --- | --- | --- |
| `linear-fixture.ts` | `LinearFixture.layer`: a real HTTP server speaking Linear's GraphQL operations, plus the real `Linear` layer pointed at it. Seeded team `Test` with every workflow state. | Seed: `addTeam`, `addEpic`, `addLabel`, `addComment`. Inspect: `issue`, `stateName`, `labelNames`, `comments`, `mutations`. Inject: `failWrite`, `rateLimitWrite`, `crashAfterWrite` (applies the write, then drops the connection), `awaitAnswers`, `awaitCrash`. |
| `github-fake.ts` | `FakeGitHub.layer`: a `GitHub` in memory, with the live layer's marker and pending rules. | `addPullRequest`, `addThread`, `setPullRequestState`; inspect `comments`, `reviews`, `thread`, `writes`; inject `failWrite`, `crashAfterWrite`. |
| `herdr-fake.ts` | `FakeHerdr.layer`: a `Herdr` in memory, with the live layer's tab and ownership logic and an event stream. | `addTab`, `setAgentStatus`, `setAgent`, `setTail`, `removeTab`, `setStartBehaviour`; inspect `tabs`, `starts`, `prompts`, `sentKeys`, `closedTabs`, `writes`; `emit` (a state change without `emit` is a dropped event), `disconnect`, `awaitConnections`; inject `failWrite`, `crashAfterWrite`. |
| `fixtures/herdr/` | Real herdr JSON output and socket events, recorded from a named session. | Used by the herdr service tests, through a fake process spawner that answers each herdr command with them. |

Inject fake crashes with a `Transient` error, so the epic's work stops without a failure comment. When a Linear write fails or crashes, the call policy waits on the clock before retrying: call `awaitAnswers` (or `awaitCrash`) before `TestClock.adjust`.

### Test harness (`test-harness.ts`)

`makeHarness(settings?)` (needs a `Scope`) wires the production rules to real temp git repos (a bare origin whose path ends in `github.com/test/repo.git`, so `githubRepo` is `test/repo`, and a clone), a temp `claude.json`, the Linear fixture, the GitHub and herdr fakes and a SQLite journal file. It returns:

- `tick`, `pausedTick`, `reconciler`: drive the planner as the service does.
- `restart`: a process restart. The planner, rules and journal connection are built again on the same journal file, while Linear, GitHub, herdr and the repos keep their state.
- `crashAtJournalWrite(n)`, `crashed()`, `journalWrites()`: the nth journal write from now dies before it is applied.
- `startedRun(seed)`: an epic in Implementing with a real worktree, a tab running Claude and a `running` row.
- `runs`, `putRun`, `moveEpic`, `renameTab`, `writeResultFile`, `worktrees()`, `hasBranch`, plus `git(cwd, ...args)` for test commits and pushes.

For lifecycle-style tests: advance `TestClock` before a follow-up claim (its summary marker is keyed by the claim time) and push the branch to origin first, so `pull --ff-only` works.

### The lifecycle test

`lifecycle.test.ts` runs one epic through everything on the harness: dispatch, a question and a relayed reply, results with a flags review, a follow-up that replies to and resolves an `/agent` thread, and cleanup once the PR is merged. Each step does what the user or agent does, then ticks until the reconciler got there. It first runs without a crash and asserts the end state, while counting the writes of each kind (journal, Linear, GitHub, herdr). Then it runs once per write with a crash injected at it, in an order shuffled by a seeded PRNG, restarting the reconciler right after the crash, and asserts the same end state and no double posts. Add a step there when a rule gains a write.

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
- Clean up with `herdr --session hl-test server stop` (only that session).

## Git

- Commit with the global git identity (signed commits are on by default). No AI attribution.
- Don't push.
