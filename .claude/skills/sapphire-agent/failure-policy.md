# Failure policy

## Two kinds of failure

Every call to T3, git, gh, Linear, the GitHub App API and Pushover fails with one of two tagged errors (`call-policy.ts`):

| Error | Means | Examples |
| --- | --- | --- |
| `Transient` | Worth retrying; may carry `retryAfter` (Retry-After). | Timeout, HTTP 5xx, network error, rate limit, git lock file held. |
| `Permanent` | Retrying cannot help. | HTTP 4xx, GraphQL error, schema decode failure, missing repo, unresolvable repo label. |

- Linear: 429, or 400 with GraphQL code `RATELIMITED` (most of its rate limits), is Transient with `retryAfter`; 5xx and transport errors Transient; other 4xx, GraphQL errors, decode failures Permanent.
- gh: Transient when stderr shows a connection error, timeout, 5xx, 429 or rate limit; else Permanent (gh exits non-zero on GraphQL errors).
- GitHub App API: 429 and 5xx Transient; other non-2xx Permanent with GitHub's `message`. Pushover: Outages.
- git: Transient for a held lock file, and a network error during `fetch`/`pull`; else Permanent.
- T3: 5xx and transport Transient; other 4xx and JSON-RPC errors Permanent. Plus `T3Unauthorized` (401) and `T3ToolFailure` (tool answered `isError`, with T3's `code`, e.g. `thread_not_found`, and message), never retried. A 404 for the MCP session (T3 restarted) opens a new session and repeats once.

## The call policy

`withCallPolicy(timeout)` wraps every external call; each method is one unit, so a retry repeats its marker or state check:

- Timeout per attempt: git and T3 30 s; gh, GitHub App API, Linear, Pushover 20 s; `t3_thread_wait` its `timeoutMs` + 30 s. A timeout is Transient.
- Up to 3 retries of a Transient, after 1, 2, 4 s jittered, or exactly `retryAfter`. Then the call and the epic's work fail for this tick.
- Permanent is not retried.

The **write policy** is for writes with nothing to check first: one timeout over all attempts, a timeout never retried (it may have landed), Transients before it still retried; the next tick observes what happened. Used by Pushover sends, T3 `ping` (so a down T3 does not hold up the tick), and `t3_thread_launch`/`t3_project_create`, which have no retry key and are one attempt (a lost thread is found by title next tick, a lost project by workspace root). Sends and interrupts carry a `clientRequestId` and take the call policy.

## At the epic level

The planner runs each epic's work in its own fiber, so one bad epic never blocks others:

- Success clears the epic's transient streak.
- Transient: logged `failed; retrying next tick`; the journal keeps the streak start. Once older than `flagTransientAfterSeconds`, a `transientFailure` notice once per streak (no label; it keeps retrying).
- Transient with `retryAfter` (the call policy already waited it between attempts): the rest of the tick is skipped (`rate limited; skipping <rule> and the rules after it until the next tick`).
- Permanent: logged `failed`; `agent-stuck` and a `permanentFailure` notice once, keyed by the run's claim time (no run: the streak start).
- Anything else (defect, journal error): logged with rule and epic, dropped; next tick retries. Interruption (shutdown) still stops the tick.

`TaskWork` (a command, a request without a run, project requests, notices) has nothing to flag: failures are logged with its `task` and retried next tick. Commands, notices and webhook deliveries handle their own (`rules.md`).

A failure while observing or planning skips that tick or rule, is logged, and writes nothing.

Rules handle some failures themselves: Permanent while starting becomes `startFailed`; a refused `send` or handoff message, and a failed nudge, are only logged (the stale flag follows anyway); a repo whose worktrees cannot be listed only skips its orphans.

Concurrency: rules run in sequence, epics within a rule in parallel; git calls share one semaphore per repo, since git takes lock files in the main repo for any of its worktrees.

## Outages

A failure of the whole service goes to the phone via `Pushover` (`pushover.ts`: `POST https://api.pushover.net/1/messages.json`, form `token`, `user`, `title`, `message`, optional `url`, `priority`, under the write policy; 5xx Transient, other non-2xx Permanent with Pushover's `errors`, a 429 being the monthly limit). `makeOutage` (`outages.ts`) tracks a failure streak in memory, ended by the first success; Pushover hears once when it has lasted the given time. A failed send is logged (`cannot send the notice to Pushover; trying again at the next failure`). A restart starts a new streak. With `renoticeAfterSeconds`, it re-notifies only that long after its last notice, across streaks.

| Title | By | When | Priority |
| --- | --- | --- | --- |
| `sapphire-agent cannot observe` | `Planner` | Observing (Linear or journal) failed for `flagTransientAfterSeconds`; nothing dispatched or watched. Log: `observing failed`. | high |
| `sapphire-agent cannot read its pause file` | `Reconciler` | First failure; the tick runs as paused. | high |
| `T3 rejects the sapphire-agent token` | `Reconciler` | Each tick pings T3; on 401 no new run starts (as if paused). Says to rerun `scripts/mint-t3-token.sh`. At most once a day. | high |

T3 being unreachable does not stop dispatch; the calls needing it fail. High (Pushover 1) is for what stops dispatch, normal (0) for the rest. Normal-priority notices besides an epic's comment: a run flagged `stale` (monitoring), a `keptWorktree` (cleanup), and `T3's settings need a change for sapphire-agent` (startup).
