# Development

How to change the code: runtime, tests, typecheck, style, safe herdr testing, and commit rules.

## Runtime

- Node 24 runs `.ts` directly via type stripping. No build step, no output dir.
- `tsconfig.json`: `erasableSyntaxOnly`, `verbatimModuleSyntax`, `allowImportingTsExtensions`, `noEmit`. So: no enums, no namespaces, no parameter properties; `import type` for types; import with `.ts` extensions.
- ESM (`"type": "module"`), top-level `await` in `main.ts`.
- Only runtime dependency: `zod` (v4, pinned). Dev: `typescript`, `@types/node`.

## Rules

- Parse every external input with zod: env, config, `claims.json`, `~/.claude.json`, herdr CLI output and events, Linear responses, `gh` output, protocol messages.
- Fail loudly with context; the dispatcher's `serial` and worker's `reconcile` log errors, nothing else swallows them.
- Keep the dispatcher/worker split: Linear only in the dispatcher, herdr/git only in the worker, contract only in `protocol.ts` (see `architecture.md`).
- Time goes through the injected `now()`; side effects through injected options. Tests rely on this.

## Commands

```sh
cd ~/herdr-linear
npm test        # node --test, all src/*.test.ts
npx tsc         # typecheck (also: npm run typecheck)
```

Run both before calling work done.

## Tests

| File | Covers | How |
| --- | --- | --- |
| `dispatcher.test.ts` | Claim/dispatch/reconcile, awaitingInput/stale/error/start timeout, nudge, wall-clock cap, result posting, follow-up runs (thread scan, dispatch, reply mismatch, replies and resolves), elicitation replies, `maxInFlight` accounting, retry, run end and cleanup decisions, pause/skip | Real `Dispatcher` + `LinearClient` against `FakeLinear`, real `ClaimStore` in a temp dir, fake `now`, real `GitHub` with a fake `gh` runner (records args and stdin, answers `pr list` and the GraphQL thread query, reply and resolve against in-memory `harness.threads`), `send` captured. |
| `git.test.ts` | `prepareWorktree`, `pullBranch` (also after cleanup), `unsavedWork`, `removeWorktree`, `parseGithubRepo`, result file path and read | Real git: bare origin, seed and clone in a temp dir. |
| `claims.test.ts` | Loading old `stuck` / `failed` statuses | Real temp file. |
| `trust.test.ts` | `trustFolder` | Real temp files. |
| `config.test.ts` | Defaults, errors, `resolveRepo` | Real files and pure calls. |

- `src/fixtures/linear-server.ts`: `FakeLinear`, an HTTP server on a random port that understands each named operation `LinearClient` sends, keeps issues/labels/comments in memory and applies mutations. Add a handler there when adding a Linear operation.
- No tests for `worker.ts` / `herdr.ts`; they need a live herdr (below).
- Tests must stay deterministic: no sleeps, control time via `harness.now`.

## Style

- Tabs, single quotes, semicolons, trailing commas, long lines OK. Match the surrounding file.
- Blank lines around guards, loops and before returns, as in existing code.
- Comments only for a non-obvious why (see existing ones in `herdr.ts`, `trust.ts`).
- File names kebab-case.

## Testing against herdr safely

The live service and your interactive herdr both use the default session (`~/.config/herdr/herdr.sock`). Never stop or restart it, and never run `herdr server stop` without `--session`.

Use a named session:

```sh
herdr --session hl-test server                 # headless server for the test session
herdr --session hl-test status server          # socket: ~/.config/herdr/sessions/hl-test/herdr.sock
```

- Point a dev run at it with `HERDR_SOCKET_PATH=~/.config/herdr/sessions/hl-test/herdr.sock`. The herdr CLI honors this env var and the worker inherits it, so both CLI calls and the event socket hit the test session.
- `HERDR_SESSION=<name>` in the env is not enough: CLI commands ignore it and talk to the default session (checked with `herdr status server` and `workspace list`).
- Use separate temp dirs for `HERDR_PLUGIN_CONFIG_DIR` and `HERDR_PLUGIN_STATE_DIR`. Set `worktreesDirectory` in that config and `CLAUDE_CONFIG_PATH` to a copy, or the dev run writes the real `~/.herdr/worktrees` and `~/.claude.json`.
- Use a scratch Linear team or the fake server, and a throwaway repo; a dev dispatcher against the real team will claim real epics alongside the live service.
- Clean up with `herdr session stop hl-test` and `herdr session delete hl-test`.

## Git

- Commit with the global git identity (signed commits are on by default). No AI attribution.
- Don't push.
