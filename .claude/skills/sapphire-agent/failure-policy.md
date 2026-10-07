# Failure policy

How every external call is bounded and classified, how a failure is retried, and when a failing epic is flagged.

## Two kinds of failure

Every call to T3, git, gh, Linear, the GitHub App API and Pushover fails with one of two tagged errors (`call-policy.ts`):

| Error | Means | Examples |
| --- | --- | --- |
| `Transient` | Worth retrying. May carry `retryAfter`, the server's Retry-After. | A timeout, HTTP 5xx, a network error, a rate limit, a git lock file held by another process. |
| `Permanent` | Retrying cannot help. | HTTP 4xx, a GraphQL error, a response that fails its schema, a missing repo, an unresolvable repo label. |

Per service:

- Linear: HTTP 429, or HTTP 400 with the GraphQL code `RATELIMITED` (how Linear reports most rate limits), is Transient with `retryAfter`. 5xx and transport errors are Transient. Other 4xx, GraphQL errors and decode failures are Permanent.
- gh: Transient when stderr shows a connection error, a timeout, HTTP 5xx, HTTP 429 or a rate limit; otherwise Permanent. gh exits non-zero on GraphQL errors.
- git: Transient for a held lock file, and for a network error during `fetch` or `pull`; otherwise Permanent.
- T3 (`t3.ts`): 5xx and transport errors are Transient, other 4xx and JSON-RPC errors Permanent. Two errors of its own besides: `T3Unauthorized` (HTTP 401, the token is rejected) and `T3ToolFailure` (a tool answered `isError`, carrying T3's `code`, e.g. `thread_not_found`, and message). Neither is retried. A 404 for the MCP session (T3 restarted) opens a new session and repeats the request once.

## The call policy

`withCallPolicy(timeout)` wraps every external call:

- A timeout per attempt: git and T3 30 s, gh, the GitHub App API, Linear and Pushover 20 s; a `t3_thread_wait` gets its `timeoutMs` plus 30 s. A timeout is a Transient.
- Up to 3 retries of a Transient, after 1 s, 2 s and 4 s, each jittered, or after exactly `retryAfter` when the error has one.
- A Permanent is not retried. Once the retries are used up, the Transient fails the call and the epic's work for this tick; the next tick tries again.

Each method is one unit under the policy, so a retried write repeats its marker or state check before writing again.

Writes that have nothing to check first use the write policy instead: the timeout covers all attempts together and a timeout is never retried, because the timed-out attempt may still have landed. Transient failures before the timeout are still retried. The next tick observes what actually happened. Pushover sends use it. T3's `t3_thread_launch` and `t3_project_create`, which have no retry key, are one attempt under the timeout, since even a failed attempt may have created the thread or project; the start rule finds such a thread by its title on the next tick, and `T3Projects` such a project by its workspace root. So is T3's `ping`, which every tick waits on to check the token, so a T3 that is down does not hold the tick up with retries. Sends and interrupts carry a `clientRequestId` T3 dedupes, so they take the call policy.

## At the epic level

The planner runs every rule's work per epic in its own fiber, so one bad epic never blocks the others, and handles what the work fails with:

- Success clears the epic's transient streak.
- Transient: logged as `failed; retrying next tick`. The journal records when the epic's streak started. Once the streak is older than `flagTransientAfterSeconds` (default 600), a `transientFailure` notice is sent once per streak (no label: it keeps retrying by itself). No notice before that.
- Transient with `retryAfter` (a rate limit): the rest of the tick is skipped (`rate limited; skipping <rule> and the rules after it until the next tick`). The call policy already waited Retry-After between its attempts.
- Permanent: logged as `failed`, and the epic is flagged once with `agent-stuck` and a `permanentFailure` notice, keyed by the run's claim time (or, without a run, by the streak start).
- Anything else (a defect, a journal error) is logged with the rule and epic and dropped; the next tick tries again. Interruption (shutdown) still stops the tick.

Work that is not about an epic (`TaskWork`: a command, a request whose epic has no run, the project requests, the notices) has nothing to flag, so the planner only logs its failures with its `task`, and the next tick tries again. A command handles its own: a Transient failure is logged and tried again next tick, a Permanent one while starting fails the command with a `commandFailed` reply on its issue or PR (`rules.md`). The notices rule tries a notice Linear refuses again next tick (`rules.md`, Notices). A webhook delivery whose command cannot be recorded is answered 500 and logged, so it stays failed in the App's delivery log, where it can be redelivered by hand.

A failure while observing or planning skips that tick or that rule and is logged; nothing is written. Observing that keeps failing for `flagTransientAfterSeconds` is sent to Pushover once per streak, at high priority (`sapphire-agent cannot observe`); so is a pause file the reconciler cannot read, at once (`sapphire-agent cannot read its pause file`). Both live in memory, so a restart during a streak sends it again (`outages.ts`). Each tick the reconciler also pings T3; while T3 answers HTTP 401 no new run starts (as if paused) and Pushover is told at high priority to run `scripts/mint-t3-token.sh` again (`T3 rejects the sapphire-agent token`), at most once a day across streaks. T3 being unreachable does not stop dispatch; the calls that need it fail.

Rule code may handle a failure itself where that is the behaviour: a Permanent while starting becomes `startFailed`, a `send` or handoff message T3 refuses is only logged, a failed nudge is only logged (the stale flag follows anyway), and a repo whose worktrees cannot be listed only skips its orphan worktrees.

## Concurrency

- Rules run one after another; within a rule, epics run in parallel.
- git calls share one semaphore per repo: git takes lock files in the main repo for operations in any of its worktrees.
